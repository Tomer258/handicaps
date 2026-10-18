"""Hangar asset validator (soundboard.md §4, security-and-operations.md file checks).

Runs with no network, no secrets and no Docker socket. Polls trusted job descriptors written by the API into
spool/jobs, decodes the quarantined upload with ffprobe/ffmpeg under resource limits and writes a normalized output
plus a result descriptor atomically. The API re-verifies everything.

- sound.normalize: canonical 48 kHz stereo s16 WAV, loudness-normalized, trimmed.
- image.normalize: decoded and re-encoded to WebP (metadata dropped) under pixel limits; avatars are
  centre-cropped to a square. GIFs become animated WebP.
"""

import hashlib
import json
import os
import re
import resource
import subprocess
import sys
import time
import wave

ROOT = os.environ.get("STORAGE_ROOT", "/data")
JOBS = os.path.join(ROOT, "spool", "jobs")
RESULTS = os.path.join(ROOT, "spool", "results")
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "0.5"))

INPUT_RE = re.compile(r"^quarantine/[0-9a-f]{32}$")
OUTPUT_RE = re.compile(r"^sounds/[0-9a-f]{32}\.wav$")
IMAGE_OUTPUT_RE = re.compile(r"^images/[0-9a-f]{32}\.webp$")
IMAGE_FORMATS = {"png_pipe", "jpeg_pipe", "webp_pipe", "gif", "image2"}
IMAGE_CODECS = {"png", "mjpeg", "webp", "gif"}
JOB_RE = re.compile(r"^[0-9a-f]{32}$")
FORMATS = {"mp3", "wav", "ogg"}
CODECS = {"mp3", "vorbis", "opus", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_u8"}

TARGET_LUFS = -18.0
TARGET_TP = -3.0
SILENCE_DB = -50.0


class Reject(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def limits() -> None:
    """Applied in the child before exec: bounded CPU, memory, output size and process count."""
    resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
    resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16 * 1024 * 1024, 16 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


FFMPEG_THREADS = os.environ.get("FFMPEG_THREADS", "2")


def capped(args: list[str]) -> list[str]:
    """ffmpeg sizes decoder/encoder/filter thread pools by the host's core count. Under the container pids limit and
    RLIMIT_AS that fails on many-core hosts ("Resource temporarily unavailable" → decode_failed), so cap them."""
    if args[0] != "ffmpeg":
        return args
    out = ["ffmpeg", "-filter_threads", FFMPEG_THREADS, "-filter_complex_threads", "1"]
    last = len(args) - 1
    for i, a in enumerate(args[1:], start=1):
        if a == "-i" or i == last:  # input decoder threads / output encoder threads
            out += ["-threads", FFMPEG_THREADS]
        out.append(a)
    return out


def run(args: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    # Argument lists only — no shell, no interpolation of names.
    return subprocess.run(capped(args), capture_output=True, text=True, timeout=timeout, preexec_fn=limits, check=False)


def probe(path: str, max_source_seconds: float) -> None:
    p = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-print_format", "json",
             "-show_format", "-show_streams", path], timeout=15)
    if p.returncode != 0:
        raise Reject("malformed")
    try:
        info = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise Reject("malformed")
    fmt = set((info.get("format", {}).get("format_name") or "").split(","))
    if not fmt & FORMATS:
        raise Reject("unsupported_format")
    streams = info.get("streams", [])
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    # Cover art in MP3s arrives as an attached-picture video stream; any other video/data stream is rejected.
    other = [s for s in streams if s.get("codec_type") != "audio" and not s.get("disposition", {}).get("attached_pic")]
    if len(audio) != 1 or other:
        raise Reject("unexpected_streams")
    a = audio[0]
    if a.get("codec_name") not in CODECS:
        raise Reject("unsupported_codec")
    if int(a.get("channels") or 0) not in range(1, 9) or int(a.get("sample_rate") or 0) not in range(8000, 192001):
        raise Reject("unsupported_layout")
    try:
        duration = float(info.get("format", {}).get("duration") or a.get("duration") or 0)
    except ValueError:
        raise Reject("malformed")
    if duration != duration or duration <= 0:  # NaN / missing
        raise Reject("malformed")
    if duration > max_source_seconds + 0.5:
        raise Reject("source_too_long")


def trim_filter(trim_start, trim_end) -> list[str]:
    if trim_start is None and trim_end is None:
        return []
    parts = []
    if trim_start is not None:
        parts.append(f"start={float(trim_start):.3f}")
    if trim_end is not None:
        parts.append(f"end={float(trim_end):.3f}")
    return ["atrim=" + ":".join(parts) + ",asetpts=PTS-STARTPTS"]


def source_peak_db(src: str, trim_start, trim_end) -> float:
    """Peak of the selected source region, measured before normalization (which would amplify near-silence)."""
    p = run(["ffmpeg", "-nostdin", "-hide_banner", "-protocol_whitelist", "file", "-i", src, "-map", "0:a:0",
             "-af", ",".join(trim_filter(trim_start, trim_end) + ["volumedetect"]), "-f", "null", "-"], timeout=20)
    if p.returncode != 0:
        raise Reject("decode_failed")
    m = re.search(r"max_volume:\s*(-?[\d.]+|-inf) dB", p.stderr)
    return float(m.group(1)) if m and m.group(1) != "-inf" else float("-inf")


def normalize(src: str, tmp: str, trim_start, trim_end, max_ms: int) -> None:
    filters = trim_filter(trim_start, trim_end)
    filters.append(f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:LRA=11")
    filters.append("alimiter=limit=0.7:level=false")
    p = run(["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file", "-i", src,
             "-map", "0:a:0", "-vn", "-sn", "-dn", "-af", ",".join(filters),
             "-t", f"{(max_ms + 400) / 1000:.3f}",
             "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", "-map_metadata", "-1",
             "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "wav", "-y", tmp], timeout=30)
    if p.returncode != 0 or not os.path.exists(tmp):
        raise Reject("decode_failed")


def measure(path: str) -> tuple[float | None, float | None]:
    p = run(["ffmpeg", "-nostdin", "-hide_banner", "-protocol_whitelist", "file", "-i", path,
             "-af", f"loudnorm=I={TARGET_LUFS}:TP={TARGET_TP}:print_format=json", "-f", "null", "-"], timeout=20)
    err = p.stderr
    loud = tp = None
    j = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", err, re.S)
    if j:
        try:
            d = json.loads(j.group(0))
            loud = float(d["input_i"]) if d["input_i"] not in ("-inf", "inf") else None
            tp = float(d["input_tp"]) if d["input_tp"] not in ("-inf", "inf") else None
        except (ValueError, KeyError, json.JSONDecodeError):
            pass
    return loud, tp


def duration_ms(path: str) -> int:
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 2 or w.getframerate() != 48000 or w.getsampwidth() != 2:
            raise Reject("output_format")
        return int(w.getnframes() * 1000 / 48000)


def write_result(job_id: str, result: dict) -> None:
    tmp = os.path.join(RESULTS, f".{job_id}.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f)
    os.replace(tmp, os.path.join(RESULTS, f"{job_id}.json"))


def probe_image(path: str, max_pixels: int, max_side: int) -> tuple[str, int, int]:
    p = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-print_format", "json",
             "-show_format", "-show_streams", path], timeout=15)
    if p.returncode != 0:
        raise Reject("malformed")
    try:
        info = json.loads(p.stdout)
    except json.JSONDecodeError:
        raise Reject("malformed")
    fmt = set((info.get("format", {}).get("format_name") or "").split(","))
    if not fmt & IMAGE_FORMATS:
        raise Reject("unsupported_format")
    streams = info.get("streams", [])
    if len(streams) != 1 or streams[0].get("codec_type") != "video":
        raise Reject("unexpected_streams")
    v = streams[0]
    codec = v.get("codec_name")
    if codec not in IMAGE_CODECS:
        raise Reject("unsupported_codec")
    w, h = int(v.get("width") or 0), int(v.get("height") or 0)
    if w <= 0 or h <= 0:
        raise Reject("malformed")
    if w > max_side or h > max_side or w * h > max_pixels:
        raise Reject("too_many_pixels")
    return codec, w, h


def image_size(path: str) -> tuple[int, int]:
    p = run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-print_format", "json", "-show_streams", path], timeout=15)
    try:
        v = json.loads(p.stdout)["streams"][0]
        return int(v["width"]), int(v["height"])
    except (json.JSONDecodeError, KeyError, IndexError, ValueError):
        raise Reject("output_format")


def process_image(job: dict, job_id: str) -> None:
    src_rel, out_rel = str(job.get("input", "")), str(job.get("output", ""))
    if not INPUT_RE.match(src_rel) or not IMAGE_OUTPUT_RE.match(out_rel):
        write_result(job_id, {"jobId": job_id, "ok": False, "error": "bad_descriptor"})
        return
    src, out = os.path.join(ROOT, src_rel), os.path.join(ROOT, out_rel)
    tmp = os.path.join(ROOT, "images", f".{job_id}.tmp.webp")
    avatar = job.get("mode") == "avatar"
    max_out = 256 if avatar else int(job.get("maxOutputSide", 2560))
    try:
        if not os.path.isfile(src):
            raise Reject("missing_source")
        codec, w, h = probe_image(src, int(job.get("maxPixels", 40_000_000)), int(job.get("maxSide", 12000)))
        if avatar:
            side = min(w, h)
            vf = f"crop={side}:{side}:(iw-{side})/2:(ih-{side})/2,scale={max_out}:{max_out}:flags=lanczos"
        else:
            vf = f"scale='min({max_out},iw)':'min({max_out},ih)':force_original_aspect_ratio=decrease:flags=lanczos"
        animated = codec == "gif" and not avatar
        args = ["ffmpeg", "-nostdin", "-v", "error", "-xerror", "-protocol_whitelist", "file", "-i", src,
                "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", vf, "-map_metadata", "-1"]
        if animated:
            args += ["-t", "30", "-c:v", "libwebp_anim", "-loop", "0", "-quality", "80"]
        else:
            args += ["-frames:v", "1", "-c:v", "libwebp", "-quality", "88"]
        args += ["-f", "webp", "-y", tmp]
        p = run(args, timeout=60)
        if p.returncode != 0 or not os.path.exists(tmp):
            raise Reject("decode_failed")
        ow, oh = image_size(tmp)
        os.replace(tmp, out)
        with open(out, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        write_result(job_id, {"jobId": job_id, "ok": True, "error": None, "width": ow, "height": oh, "sha256": digest})
        print(f"job {job_id}: image ok {w}x{h} -> {ow}x{oh}{' animated' if animated else ''}", flush=True)
    except Reject as r:
        write_result(job_id, {"jobId": job_id, "ok": False, "error": r.code})
        print(f"job {job_id}: image rejected {r.code}", flush=True)
    except subprocess.TimeoutExpired:
        write_result(job_id, {"jobId": job_id, "ok": False, "error": "timeout"})
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def process(job_path: str) -> None:
    with open(job_path, encoding="utf-8") as f:
        job = json.load(f)
    job_id = str(job.get("jobId", ""))
    if not JOB_RE.match(job_id):
        raise ValueError("bad job id")
    if job.get("type") == "image.normalize":
        process_image(job, job_id)
        return
    src_rel, out_rel = str(job.get("input", "")), str(job.get("output", ""))
    if not INPUT_RE.match(src_rel) or not OUTPUT_RE.match(out_rel):
        write_result(job_id, {"jobId": job_id, "ok": False, "error": "bad_descriptor"})
        return
    src = os.path.join(ROOT, src_rel)
    out = os.path.join(ROOT, out_rel)
    tmp = os.path.join(ROOT, "sounds", f".{job_id}.tmp.wav")
    min_ms, max_ms = int(job.get("minDurationMs", 100)), int(job.get("maxDurationMs", 5000))
    try:
        if not os.path.isfile(src):
            raise Reject("missing_source")
        probe(src, float(job.get("maxSourceSeconds", 30)))
        if source_peak_db(src, job.get("trimStart"), job.get("trimEnd")) < SILENCE_DB:
            raise Reject("silent")
        normalize(src, tmp, job.get("trimStart"), job.get("trimEnd"), max_ms)
        ms = duration_ms(tmp)
        if ms < min_ms:
            raise Reject("too_short")
        if ms > max_ms + 20:
            raise Reject("too_long")
        loud, tp = measure(tmp)
        os.replace(tmp, out)
        with open(out, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        write_result(job_id, {"jobId": job_id, "ok": True, "error": None, "loudness": loud, "truePeak": tp,
                              "durationMs": ms, "sha256": digest})
        print(f"job {job_id}: ok {ms} ms, {loud} LUFS, {tp} dBTP", flush=True)
    except Reject as r:
        write_result(job_id, {"jobId": job_id, "ok": False, "error": r.code})
        print(f"job {job_id}: rejected {r.code}", flush=True)
    except subprocess.TimeoutExpired:
        write_result(job_id, {"jobId": job_id, "ok": False, "error": "timeout"})
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def main() -> None:
    os.makedirs(RESULTS, exist_ok=True)
    print(f"asset-validator watching {JOBS}", flush=True)
    while True:
        try:
            names = sorted(n for n in os.listdir(JOBS) if n.endswith(".json") or n.endswith(".json.processing"))
        except FileNotFoundError:
            names = []
        for name in names:
            path = os.path.join(JOBS, name)
            claimed = path if name.endswith(".processing") else path + ".processing"
            try:
                if claimed != path:
                    os.replace(path, claimed)  # claim (one job at a time; leftovers from a crash are retried)
                process(claimed)
            except Exception as e:  # never let one bad descriptor stop the loop
                print(f"job {name}: error {type(e).__name__}: {e}", file=sys.stderr, flush=True)
            finally:
                if os.path.exists(claimed):
                    os.remove(claimed)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
