"""Hangar authorization watchdog (architecture: security-and-operations, runtime outage boundary).

Host-local and independent of the API: it polls the API's reconciliation status on loopback. If that status has been
unhealthy (503, or the API unreachable) for TRIP_AFTER seconds, it closes public voice access:

  1. writes FLAG_PATH: the edge (Caddy) answers 503 on every /rtc signaling route while the file exists, so no new
     join or resume reaches LiveKit even if admission were to pass;
  2. deletes every LiveKit room (RoomService over loopback), which disconnects all participants and stops their media.

Rooms are deleted again on every check while closed. Access reopens after the status has been healthy for
RECOVER_AFTER seconds; clients then rejoin through normal admission. The state survives restarts (the flag file).
Standard library only. Exit code is never relied upon: run it with restart: unless-stopped.
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import signal
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("API_URL", "http://127.0.0.1:8080").rstrip("/")
LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "http://127.0.0.1:7880").rstrip("/")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")
FLAG_PATH = os.environ.get("FLAG_PATH", "/run/hangar-watchdog/closed")
HEARTBEAT_PATH = os.environ.get("HEARTBEAT_PATH", "/tmp/heartbeat")
INTERVAL = float(os.environ.get("INTERVAL", "5"))
TRIP_AFTER = float(os.environ.get("TRIP_AFTER", "60"))
RECOVER_AFTER = float(os.environ.get("RECOVER_AFTER", "30"))
HTTP_TIMEOUT = 3

log = logging.getLogger("auth-watchdog")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def admin_token() -> str:
    """Short-lived HS256 LiveKit token: list and delete rooms only."""
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    claims = {"iss": LIVEKIT_API_KEY, "sub": "hangar-watchdog", "nbf": now - 5, "exp": now + 60,
              "video": {"roomList": True, "roomCreate": True}}
    signing = b64url(json.dumps(header, separators=(",", ":")).encode()) + "." + \
        b64url(json.dumps(claims, separators=(",", ":")).encode())
    sig = hmac.new(LIVEKIT_API_SECRET.encode(), signing.encode(), hashlib.sha256).digest()
    return signing + "." + b64url(sig)


def room_service(method: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{LIVEKIT_URL}/twirp/livekit.RoomService/{method}", data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + admin_token()})
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as r:
        return json.loads(r.read() or b"{}")


def reconcile_healthy() -> bool:
    try:
        with urllib.request.urlopen(f"{API_URL}/internal/watchdog/reconcile", timeout=HTTP_TIMEOUT) as r:
            return r.status == 200 and json.loads(r.read()).get("healthy") is True
    except urllib.error.HTTPError as e:
        if e.code != 503:
            log.warning("status endpoint returned %s", e.code)
        return False
    except (OSError, ValueError) as e:
        log.warning("status endpoint unreachable: %s", e)
        return False


def evict_all() -> None:
    try:
        rooms = room_service("ListRooms", {}).get("rooms", [])
        for room in rooms:
            room_service("DeleteRoom", {"room": room["name"]})
        if rooms:
            log.error("closed %d voice room(s): %s", len(rooms), ", ".join(r["name"] for r in rooms))
    except (OSError, ValueError, KeyError) as e:
        # LiveKit down means no media flows either; the flag still blocks signaling.
        log.error("could not delete LiveKit rooms: %s", e)


def set_flag(closed: bool) -> None:
    if closed:
        if os.path.exists(FLAG_PATH):
            return
        with open(FLAG_PATH, "w") as f:
            f.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " reconciliation unhealthy\n")
    elif os.path.exists(FLAG_PATH):
        os.remove(FLAG_PATH)


def beat() -> None:
    with open(HEARTBEAT_PATH, "w") as f:
        f.write(str(int(time.time())))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
        raise SystemExit("LIVEKIT_API_KEY and LIVEKIT_API_SECRET are required")
    stop = False

    def on_signal(*_):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)

    closed = os.path.exists(FLAG_PATH)
    unhealthy_since = time.monotonic() if closed else None
    healthy_since = None
    log.info("started (trip after %ss, recover after %ss, %s)", TRIP_AFTER, RECOVER_AFTER, "CLOSED" if closed else "open")

    while not stop:
        now = time.monotonic()
        if reconcile_healthy():
            unhealthy_since = None
            healthy_since = healthy_since or now
            if closed and now - healthy_since >= RECOVER_AFTER:
                set_flag(False)
                closed = False
                log.warning("reconciliation healthy for %ds: voice signaling reopened", RECOVER_AFTER)
        else:
            healthy_since = None
            if unhealthy_since is None:
                unhealthy_since = now
                log.warning("reconciliation unhealthy; closing voice in %ds unless it recovers", TRIP_AFTER)
            if not closed and now - unhealthy_since >= TRIP_AFTER:
                set_flag(True)
                closed = True
                log.error("reconciliation unhealthy for %ds: voice signaling CLOSED", TRIP_AFTER)
        if closed:
            set_flag(True)  # recreate if removed by hand while still unhealthy
            evict_all()
        beat()
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
