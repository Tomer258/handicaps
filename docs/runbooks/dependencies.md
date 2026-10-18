# Dependencies: pinned versions and licenses

Every third-party input to a release is pinned, so the same commit builds the same release. Upgrades are deliberate:
one pull request that changes a pin and passes CI, the dev smokes and, for media components, the POC smoke.

## What is pinned, and how

| Input | Where | How |
|---|---|---|
| Base images (PostgreSQL 18.6, Python 3.13.16, .NET SDK 10.0.402 / ASP.NET 10.0.13, Node 22.22.0, Caddy 2.11.4, LiveKit v1.9.1, docker 28.5.1-dind) | Dockerfiles, `infra/compose.*.yml`, `poc-local.sh` | `tag@sha256:` multi-arch index digest |
| Caddy layer4 module | `infra/caddy/Dockerfile` | `caddy-l4@v0.1.2`, built with xcaddy for Caddy v2.11.4 |
| NuGet | `*.csproj` | exact versions; EF Core pinned to 10.0.13 through an explicit Relational reference |
| npm | `apps/web/package-lock.json` | `npm ci` with npm 11.6.2 (Angular 21.2.25, livekit-client 2.23.0, @microsoft/signalr 10.0.11, qrcode-generator 1.4.4 for the 2FA QR) |
| Python (sound publisher) | `workers/sound-publisher/requirements.lock` | full graph with hashes; `pip install --require-hashes --only-binary=:all:` |
| Alpine packages (backup) | `infra/backup/Dockerfile` | `age=1.3.2-r1 rclone=1.74.1-r3` |
| Debian ffmpeg (asset validator) | `workers/asset-validator/Dockerfile` | **not version-pinned**: Debian removes superseded security builds, which would break the build. The pinned base fixes the Debian release (13 trixie); currently `7.1.5-0+deb13u1`. |

The other Python workers (auth watchdog, ops monitor, validator) use only the standard library.

## Updating a pin

```sh
# image: read the new digest without pulling it
docker buildx imagetools inspect postgres:18.7-alpine | grep ^Digest
# Python lock: edit requirements.txt, then regenerate the hash lock inside the pinned image (nothing installed on the host)
docker run --rm -v "$PWD/workers/sound-publisher:/w" -w /w python:3.13.16-slim@sha256:<digest> sh -c \
  "pip install -q uv==0.9.5 && uv pip compile -q --generate-hashes --python-version 3.13 \
   --python-platform x86_64-manylinux_2_28 --no-header -o requirements.lock requirements.txt"
```

The production host is x86_64. If an arm64 host is ever used, regenerate the lock for `aarch64-manylinux_2_28` as well.

PostgreSQL: a minor version change (18.6 → 18.7) is a plain image swap. A major version needs dump/restore
(backup-restore.md). LiveKit: also bump `livekit-client` together, check the release notes for protocol changes, and
run the POC smoke. ASP.NET's signaling contract tests cover the RoomService calls.

## Licenses

CI runs `infra/scripts/license-report.py` on the shipped NuGet and npm packages and on the Python packages in the
publisher image. It fails on strong-copyleft or unrecognised licenses that haven't been reviewed.

Result 2026-10-18: 73 NuGet + npm packages and 14 Python packages, all permissive (MIT, Apache-2.0, BSD-2/3-Clause,
ISC, 0BSD, PostgreSQL, Unlicense, Zlib, CC0, PSF). None are copyleft.

Server components, which run as separate programs and are not linked into Hangar:

| Component | License | Note |
|---|---|---|
| LiveKit server | Apache-2.0 | |
| Caddy, caddy-l4 | Apache-2.0 | |
| PostgreSQL | PostgreSQL | |
| FFmpeg (Debian build) | GPL-2+ / LGPL-2.1+ | Called as a separate executable on the private host; Hangar's code is not a derivative. GPL obligations only apply when the image is *distributed* to others. In that case, provide the corresponding source (Debian source packages) on request. |
| age, rclone | BSD-3-Clause, MIT | |
