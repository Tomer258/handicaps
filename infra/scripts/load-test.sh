#!/usr/bin/env bash
# Capacity scenarios A/B/C (docs/architecture/capacity-and-hosting.md §3) with the pinned LiveKit CLI.
# Run on a SEPARATE load-generator machine (never on the Hangar host: it would compete for the CPU being measured),
# while `python3 -I infra/scripts/load-sample.py --scenario <S>` runs on the host. Full procedure: runbooks/load-test.md.
#
#   LIVEKIT_API_SECRET=... ./load-test.sh A [30m]
#
# Signaling goes through an SSH tunnel to the host's loopback LiveKit (the public /rtc gate admits only real leases);
# media flows over the public UDP/TCP ports exactly like real clients:
#   ssh -N -L 7880:127.0.0.1:7880 <admin>@<host>
#
# How the scenarios are approximated (lk publishers don't subscribe; subscribers receive everything published):
#   A  15 speaking mics, 1 screen (high layer)            → 10 subscribers
#   B  15 speaking mics, 2 screens                         → 10 subscribers
#   C  15 speaking mics, 4 screens + 6 cameras (medium)    → 14 subscribers
# Layout 5x5 makes every subscriber take every track (full audio fan-out, video at a grid layer): the packet and
# subscription load the SFU CPU actually depends on. lk's "high" video is ~1.5 Mbps 720p, not an 8 Mbps 1080p60
# screen, so egress here is BELOW the model; the provider's sustained egress is measured separately (iperf3, runbook).
# Soundboard effects (≤0.2 Mbps) are left out.
set -euo pipefail

LK_IMAGE="livekit/livekit-cli:v2.18.8@sha256:04eff828f8edd810b996c18456a6260ba0698a60f8ea309d0f015c2b09696413"
SCENARIO="${1:?usage: load-test.sh A|B|C [duration, default 30m]}"
DURATION="${2:-30m}"
: "${LIVEKIT_URL:=ws://127.0.0.1:7880}"
: "${LIVEKIT_API_KEY:=loadtest}"
: "${LIVEKIT_API_SECRET:?set LIVEKIT_API_SECRET (the temporary loadtest key from livekit-keys.yaml)}"
ROOM="loadtest_$(echo "$SCENARIO" | tr 'A-Z' 'a-z')_$(date -u +%H%M%S)"

lk() {
  docker run --rm --network "${LK_NETWORK:-host}" -e LIVEKIT_URL -e LIVEKIT_API_KEY -e LIVEKIT_API_SECRET "$LK_IMAGE" "$@"
}
export LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET

case "$SCENARIO" in
  A) runs=("--audio-publishers 15 --video-publishers 1 --video-resolution high --subscribers 10 --layout 5x5") ;;
  B) runs=("--audio-publishers 15 --video-publishers 2 --video-resolution high --subscribers 10 --layout 5x5") ;;
  C) runs=("--audio-publishers 15 --video-publishers 4 --video-resolution high --subscribers 10 --layout 5x5"
           "--video-publishers 6 --video-resolution medium --subscribers 4 --layout 5x5") ;;
  *) echo "unknown scenario $SCENARIO" >&2; exit 2 ;;
esac

echo "room $ROOM, $DURATION, via $LIVEKIT_URL"
lk room create --empty-timeout 120 --departure-timeout 30 "$ROOM" >/dev/null
trap 'lk room delete "$ROOM" >/dev/null 2>&1 || true' EXIT

pids=()
i=0
for args in "${runs[@]}"; do
  # shellcheck disable=SC2086  # word splitting of the scenario flags is intended
  lk load-test --room "$ROOM" --duration "$DURATION" --identity-prefix "sim${i}_" --num-per-second 2 --simulate-speakers $args &
  pids+=($!)
  i=$((i + 1))
done
status=0
for p in "${pids[@]}"; do wait "$p" || status=$?; done
echo "load test finished (exit $status). Collect the host summary from load-sample.py."
exit "$status"
