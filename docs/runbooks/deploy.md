# Deploy

## 1. Host preparation (once)

1. Ubuntu LTS (or Debian) VPS with Docker Engine and the Compose plugin. Use key-only SSH, disable root login and
   turn on unattended security updates.
2. DNS: point the `app.`, `rtc.` and `turn.` A/AAAA records at the VPS.
3. Firewall (on the host **and** at the provider). Docker-published ports bypass UFW, so every service here uses
   host networking or loopback-only publishing. Verify from outside afterwards (§3).

   | Allow inbound | Purpose |
   |---|---|
   | 80/tcp, 443/tcp | ACME, HTTPS/WSS and TURN/TLS (Caddy's layer4 module routes by SNI) |
   | 7881/tcp | ICE/TCP fallback |
   | 7882/udp | ICE/UDP (single-port mux) |
   | 3478/udp | TURN/UDP and STUN |
   | 22/tcp | Admin IPs or VPN only |

   **Drop everything else, explicitly including 5349/tcp.** LiveKit v1.9.1 binds its plaintext TURN backend on all
   interfaces, even with `bind_addresses: [127.0.0.1]` (verified 2026-10-18). Configuration already keeps these
   loopback-only: 7880 (signaling), 6789 (metrics), 8080 (API), 8090 (publisher), 8443 and 2019 (Caddy internal)
   and 5432 (Postgres).
4. Kernel buffers for media (LiveKit warns otherwise):

   ```sh
   printf 'net.core.rmem_max=5000000\nnet.core.wmem_max=5000000\n' | sudo tee /etc/sysctl.d/90-livekit.conf
   sudo sysctl --system
   ```

5. Directories and ownership. uid 10001 is shared by the API and the asset validator; uid 10002 (publisher) only
   reads sounds.

   ```sh
   sudo mkdir -p /srv/hangar/{config,data/keys,postgres,caddy/data,caddy/config,backups}
   sudo mkdir -p /srv/hangar/data/files/{quarantine,spool/jobs,spool/results,sounds,images,attachments}
   sudo chown -R 10001:10001 /srv/hangar/data
   sudo chmod 700 /srv/hangar/config /srv/hangar/data/keys
   ```

6. Config: copy `infra/config.example/*` and `infra/livekit.prod.yaml` (as `livekit.yaml`) into
   `/srv/hangar/config`. Fill every `CHANGE_ME` (`openssl rand -hex 32`) and set `turn.domain` in `livekit.yaml`.
   Write `postgres_password` without a trailing newline (`printf %s "$PW" > postgres_password`). Then `chmod 600`
   every secret file; LiveKit refuses to start with a key file that others can read.

## 2. Release

```sh
cd /opt/hangar && git fetch --tags && git checkout <tag>
# set HANGAR_VERSION=<tag> in /srv/hangar/config/hangar.env
dc build                                   # or pull prebuilt images by digest
dc --profile ops run --rm backup           # back up BEFORE migrating (skip on first install)
dc up -d postgres
dc --profile release run --rm migrate      # applies migrations; prints a one-time owner invite on first install
dc up -d                                   # edge, api, livekit, workers
```

An app-only release (`api`, `edge`, workers) does not need to restart `livekit`. Restarting LiveKit drops every
call, so schedule it.

## 3. Verify

- `curl -fsS https://app.example.com/` serves the SPA.
- `curl -s -o /dev/null -w '%{http_code}\n' https://app.example.com/internal/livekit/admission` returns 404.
- `curl -s -o /dev/null -w '%{http_code}\n' https://rtc.example.com/rtc/validate` returns 403 (no token), and
  `https://rtc.example.com/twirp/livekit.RoomService/ListRooms` returns 404.
- From a machine outside the host, `nmap -Pn -p 5349,7880,8080,5432,6789,8443 <vps>` shows every port closed or
  filtered.
- Sign in, send a message with an attachment, and join voice from two networks, one with UDP blocked (it should
  fall back to TURN/TLS on 443).
- `dc logs edge | grep access_token` returns nothing (tokens are stripped from the access logs).
- First install: open the owner invite from the migrate output, then clear it from your terminal history.
