# Load tests A/B/C and the four-hour soak

Goal (capacity-and-hosting.md §8): on the real host, run scenarios A, B and C for 30 minutes each, plus a mixed
four-hour soak. Pass when:
- sustained CPU stays at or below 75 % (p95)
- there is no material steal (p95 < 5 %)
- at least 1.5 GiB of memory stays available
- queues don't grow
- voice and video stay acceptable to a person listening in

If A and B pass and C fails, cap subscriptions or bitrate, or move to 6–8 vCPU / 12–16 GB. Never raise bitrate to
cover for packet loss.

There are three separate measurements, because the simulator can't reproduce everything at once:

| What | Tool | Why separately |
|---|---|---|
| Provider's sustained egress (target ≥ 700 Mbps for C) | `iperf3`, reverse mode | `lk` video is ~1.5 Mbps 720p, not an 8 Mbps screen, so simulated egress stays below the model |
| SFU CPU / memory under the scenario's track and subscription counts | `infra/scripts/load-test.sh` (pinned `lk load-test`) + `infra/scripts/load-sample.py` on the host | Forwarding cost scales with tracks × subscribers × packets, which the simulator reproduces (layout 5x5 = every subscriber takes every track) |
| Perceived quality | two real browsers joined during each run | Simulated clients can't tell you whether it sounds right |

## Before: put the host in load-test mode (temporary)

1. Add a temporary LiveKit key to `/srv/hangar/config/livekit-keys.yaml`: `loadtest: <openssl rand -hex 32>`.
2. Add `Hangar__LiveKit__LoadTestRoomPrefix=loadtest_` to `/srv/hangar/config/hangar.env`. Without it, the
   reconciler evicts the simulated participants within 15 s. The API refuses a prefix that overlaps real `v_` rooms
   and logs `LOAD TEST MODE` at startup.
3. Run `dc up -d livekit api`, then `dc logs api | grep "LOAD TEST MODE"`.
4. Tell people. A real voice call during the test will suffer, and the numbers will be wrong.

## Throughput (once)

```sh
# host: temporary iperf3 server, reachable only from the load generator
sudo ufw allow from <gen-ip> to any port 5201 proto tcp && iperf3 -s -p 5201 -1
# generator: host → generator (egress), 8 streams, 60 s
iperf3 -c <host> -p 5201 -R -P 8 -t 60
# host: remove the rule
sudo ufw delete allow from <gen-ip> to any port 5201 proto tcp
```

Record the receiver's sum. Repeat in the evening, since shared ports sag at peak times.

## Each scenario (A, then B, then C)

On a **separate** machine with Docker, at least 4 cores and a good uplink. Running it on the host would compete
for the CPU being measured. Signaling goes through an SSH tunnel; media uses the public UDP/TCP ports like real
clients.

```sh
ssh -N -L 7880:127.0.0.1:7880 <admin>@<host> &           # generator
LIVEKIT_API_SECRET=<loadtest secret> infra/scripts/load-test.sh A 30m
```

At the same time, on the host:

```sh
python3 -I infra/scripts/load-sample.py --scenario A --minutes 30 --out /srv/hangar/loadtest/A.csv
```

While it runs:
- Join a normal Hangar voice channel from two real browsers, and share a screen in C.
- Note audio delay, dropouts and video artifacts.
- Run `dc stats --no-stream livekit api` a few times.

Before the next run, wait until CPU settles, about 2 minutes.

Dry run on the dev stack (2026-10-18, Docker Desktop, `LK_NETWORK=container:hangar-dev-livekit-1`): A with 25
simulated participants (16 tracks; each subscriber took 16/16 with 5x5) and C with two concurrent simulator
processes. Both had 0 % loss. The participants survived reconcile passes in load-test mode, and the room was
deleted afterwards.

## Soak (four hours, mixed)

Run `load-test.sh B 240m` (or A for 2 h, then B, then C for 30 min) together with
`load-sample.py --scenario SOAK --minutes 240`. Besides the pass criteria, check:
- MemAvailable has no downward trend in the CSV
- `dc stats` memory of `livekit` and `api` stays flat
- no `ALERT` from the ops monitor other than expected CPU alerts

## After: leave load-test mode

1. Remove the `loadtest:` line from `livekit-keys.yaml` and the `LoadTestRoomPrefix` line from `hangar.env`.
2. Run `dc up -d livekit api`. Check that `dc logs api | grep "LOAD TEST MODE"` shows nothing new.
3. Stop the SSH tunnel. Check that `ufw status` has no leftover rule.

## Results (fill in)

| Run | Date / time | vCPU / RAM | p95 CPU | p95 steal | min MemAvailable | avg tx | iperf3 egress | Real-client notes | Result |
|---|---|---|---|---|---|---|---|---|---|
| A | | | | | | | | | |
| B | | | | | | | | | |
| C | | | | | | | | | |
| Soak | | | | | | | — | | |
