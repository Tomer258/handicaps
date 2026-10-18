"""Hangar sound publisher (soundboard.md §2, ADR 006/007).

A narrow, publish-only LiveKit participant per occupied room. The API authorizes every play and sends an allowlisted
command with a room-scoped token; this worker never subscribes to anyone, never sees a client path and holds no
LiveKit secret. One long-lived audio track per actor ("sfx_<userId>") so listeners can mute one person's effects.
"""

import asyncio
import hashlib
import hmac
import logging
import os
import re
import time
import wave
from dataclasses import dataclass, field

from aiohttp import ClientSession, ClientTimeout, web
from livekit import rtc

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://127.0.0.1:7880")
API_URL = os.environ.get("API_URL", "http://host.docker.internal:5080")
WORKER_KEY = os.environ.get("WORKER_KEY", "")
LISTEN_HOST = os.environ.get("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("LISTEN_PORT", "8090"))
SOUNDS_ROOT = os.environ.get("SOUNDS_ROOT", "/data")
ROOM_IDLE_SECONDS = float(os.environ.get("ROOM_IDLE_SECONDS", "60"))

SAMPLE_RATE = 48000
CHANNELS = 2
FRAME_SAMPLES = 960  # 20 ms
FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2
FILE_RE = re.compile(r"^sounds/[0-9a-f]{32}\.wav$")
ROOM_RE = re.compile(r"^v_[0-9a-f]{32}_\d+$")
ID_RE = re.compile(r"^[0-9a-f-]{36}$")

EPOCH = time.time_ns()
log = logging.getLogger("sound-publisher")


@dataclass
class ActorTrack:
    source: rtc.AudioSource
    track: rtc.LocalAudioTrack


@dataclass
class RoomConn:
    name: str
    room: rtc.Room
    tracks: dict[str, ActorTrack] = field(default_factory=dict)
    last_used: float = field(default_factory=time.monotonic)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


@dataclass
class Play:
    playback_id: str
    room: str
    actor: str
    task: asyncio.Task | None = None
    started: asyncio.Event = field(default_factory=asyncio.Event)
    stopped: bool = False


rooms: dict[str, RoomConn] = {}
plays: dict[str, Play] = {}
pcm_cache: dict[str, bytes] = {}  # sha256 -> PCM, bounded below
http: ClientSession | None = None


def authorized(request: web.Request) -> bool:
    presented = request.headers.get("X-Hangar-Worker-Key", "")
    return len(WORKER_KEY) >= 16 and hmac.compare_digest(presented.encode(), WORKER_KEY.encode())


def load_pcm(rel: str, sha256: str) -> bytes:
    """Reads the finalized canonical WAV (read-only mount) and verifies the immutable version hash."""
    if sha256 in pcm_cache:
        return pcm_cache[sha256]
    path = os.path.join(SOUNDS_ROOT, rel)
    with open(path, "rb") as f:
        raw = f.read(4 * 1024 * 1024 + 1)
    if hashlib.sha256(raw).hexdigest() != sha256:
        raise ValueError("hash_mismatch")
    with wave.open(path, "rb") as w:
        if w.getframerate() != SAMPLE_RATE or w.getnchannels() != CHANNELS or w.getsampwidth() != 2:
            raise ValueError("format")
        pcm = w.readframes(w.getnframes())
    if len(pcm_cache) >= 64:
        pcm_cache.pop(next(iter(pcm_cache)))
    pcm_cache[sha256] = pcm
    return pcm


async def ensure_room(name: str, token: str) -> RoomConn:
    conn = rooms.get(name)
    if conn and conn.room.isconnected():
        return conn
    if conn:
        rooms.pop(name, None)
    room = rtc.Room()
    await room.connect(LIVEKIT_URL, token, rtc.RoomOptions(auto_subscribe=False))
    conn = RoomConn(name=name, room=room)
    rooms[name] = conn
    log.info("connected to %s", name)
    return conn


async def ensure_track(conn: RoomConn, actor: str) -> ActorTrack:
    async with conn.lock:
        t = conn.tracks.get(actor)
        if t:
            return t
        source = rtc.AudioSource(SAMPLE_RATE, CHANNELS, queue_size_ms=100)
        track = rtc.LocalAudioTrack.create_audio_track(f"sfx_{actor}", source)
        opts = rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_UNKNOWN, dtx=False, red=False)
        await conn.room.local_participant.publish_track(track, opts)
        t = ActorTrack(source=source, track=track)
        conn.tracks[actor] = t
        return t


async def report(playback_id: str, state: str, code: str | None = None) -> None:
    try:
        assert http is not None
        async with http.post(f"{API_URL}/internal/soundboard/events",
                             json={"playbackId": playback_id, "epoch": EPOCH, "state": state, "code": code},
                             headers={"X-Hangar-Worker-Key": WORKER_KEY}) as r:
            await r.read()
    except Exception as e:  # the API reconciles from /health if a callback is lost
        log.warning("report %s %s failed: %s", playback_id, state, e)


async def feed(play: Play, t: ActorTrack, pcm: bytes) -> None:
    state, code = "completed", None
    try:
        t.track.unmute()
        for off in range(0, len(pcm), FRAME_BYTES):
            chunk = pcm[off:off + FRAME_BYTES]
            if len(chunk) < FRAME_BYTES:
                chunk = chunk + bytes(FRAME_BYTES - len(chunk))
            await t.source.capture_frame(rtc.AudioFrame(chunk, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES))
            play.started.set()
        await t.source.wait_for_playout()
    except asyncio.CancelledError:
        state = "stopped"
        t.source.clear_queue()  # drop the ~100 ms queue; already-sent audio cannot be recalled
    except Exception as e:
        state, code = "failed", type(e).__name__[:40]
        log.exception("playback %s failed", play.playback_id)
    finally:
        play.started.set()
        try:
            t.track.mute()
        except Exception:
            pass
        plays.pop(play.playback_id, None)
        rc = rooms.get(play.room)
        if rc:
            rc.last_used = time.monotonic()
        if not play.stopped:
            await report(play.playback_id, state, code)


async def handle_play(request: web.Request) -> web.Response:
    if not authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    body = await request.json()
    pid, room, token = str(body.get("playbackId", "")), str(body.get("room", "")), str(body.get("token", ""))
    actor, rel, sha = str(body.get("actor", "")), str(body.get("file", "")), str(body.get("sha256", ""))
    if not (ID_RE.match(pid) and ROOM_RE.match(room) and ID_RE.match(actor) and FILE_RE.match(rel) and re.match(r"^[0-9a-f]{64}$", sha)):
        return web.json_response({"state": "failed", "epoch": EPOCH, "code": "bad_command"}, status=400)
    if pid in plays:  # duplicate delivery returns the prior state
        return web.json_response({"state": "playing", "epoch": EPOCH, "code": None})
    try:
        pcm = load_pcm(rel, sha)
        conn = await ensure_room(room, token)
        t = await ensure_track(conn, actor)
    except Exception as e:
        log.warning("play %s rejected: %s", pid, e)
        return web.json_response({"state": "failed", "epoch": EPOCH, "code": str(e)[:40] or type(e).__name__})
    # One effect per actor track: a stale one (should not happen — the API serializes) is cut.
    for other in [p for p in plays.values() if p.room == room and p.actor == actor]:
        other.stopped = True
        if other.task:
            other.task.cancel()
    play = Play(playback_id=pid, room=room, actor=actor)
    plays[pid] = play
    conn.last_used = time.monotonic()
    play.task = asyncio.create_task(feed(play, t, pcm))
    try:
        await asyncio.wait_for(play.started.wait(), timeout=2.0)
    except asyncio.TimeoutError:
        play.stopped = True
        play.task.cancel()
        return web.json_response({"state": "failed", "epoch": EPOCH, "code": "start_timeout"})
    return web.json_response({"state": "playing", "epoch": EPOCH, "code": None})


async def handle_stop(request: web.Request) -> web.Response:
    if not authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    body = await request.json()
    play = plays.get(str(body.get("playbackId", "")))
    if play:
        play.stopped = True  # the API already recorded the stop
        if play.task:
            play.task.cancel()
    return web.json_response({"ok": True})


async def handle_health(request: web.Request) -> web.Response:
    if not authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.json_response({"epoch": EPOCH, "active": list(plays.keys()), "rooms": len(rooms)})


async def janitor() -> None:
    """Leaves rooms that are idle and empty of humans; tracks go with the room."""
    while True:
        await asyncio.sleep(5)
        now = time.monotonic()
        for name, conn in list(rooms.items()):
            busy = any(p.room == name for p in plays.values())
            humans = [p for p in conn.room.remote_participants.values() if not p.identity.startswith("sb_")]
            if not busy and (not conn.room.isconnected() or (not humans and now - conn.last_used > 5) or now - conn.last_used > ROOM_IDLE_SECONDS):
                rooms.pop(name, None)
                try:
                    await conn.room.disconnect()
                except Exception:
                    pass
                log.info("left %s", name)


async def main() -> None:
    global http
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if len(WORKER_KEY) < 16:
        raise SystemExit("WORKER_KEY must be set (>= 16 chars)")
    http = ClientSession(timeout=ClientTimeout(total=3))
    app = web.Application(client_max_size=16 * 1024)
    app.router.add_post("/play", handle_play)
    app.router.add_post("/stop", handle_stop)
    app.router.add_get("/health", handle_health)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, LISTEN_HOST, LISTEN_PORT).start()
    log.info("sound-publisher epoch %s listening on %s:%s (livekit %s)", EPOCH, LISTEN_HOST, LISTEN_PORT, LIVEKIT_URL)
    await janitor()


if __name__ == "__main__":
    asyncio.run(main())
