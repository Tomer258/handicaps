# Capacity model and hosting comparison

**Research date: 17 October 2026. All performance figures in this proposal are estimates unless explicitly described as vendor benchmarks. No VPS or Israeli network has been benchmarked for this project.**

## 1. Explicit media assumptions

Use decimal units: 1 Mbps = 1,000,000 bits/s; 1 GB = 1,000,000,000 bytes; 1 TB = 1,000 GB. Provider accounting may use different units or round billing increments. Simultaneous viewers means subscriptions, not unique extra people: the same ten users may watch both streams in scenario B.

| Quantity | Planning value | Explanation |
|---|---|---|
| Humans | 15 | One voice room is the worst audio fanout |
| Microphone | 0.064 Mbps each | Conservative all-speaking ceiling; silence suppression can reduce actual traffic |
| Screen high layer | 8.0 Mbps, 1080p/60 target | A cap, not a quality guarantee for every game |
| Screen lower layers | 2.0 + 0.4 Mbps | Extra encoder/upload work when these layers are active |
| Screen audio | 0.128 Mbps per publisher | Stereo Opus planning value |
| Camera high layer | 1.2 Mbps at 720p/30 | Six cameras in scenario C |
| Camera low layer | 0.3 Mbps | Included in external ingress assumption |
| Soundboard | 0.096 Mbps per active effect | At most two, forwarded to all 15 humans, including triggerer |
| Control/text reserve | 0.25 Mbps inbound, 1 Mbps outbound | Separate from large attachment bursts |
| Packet/retransmission allowance | 20% on aggregate | Approximate allowance, not a guarantee under severe loss/RED |
| Monthly example | 4 hours/day × 30 days = 120 hours | A usage assumption; do not charge peak rate for 24/7 implicitly |

The high-layer screen viewer receives one selected layer, not all simulcast layers. Ingress includes every active encoding layer; egress sums the layer selected for each subscriber. SFU forwarding does not multiply video encoding CPU by the number of viewers.

## 2. Equations

Let N=15; S=screen publishers; V=high-layer viewers per screen; C=camera publishers; B=active soundboard effects. All bitrates below are Mbps.

`External ingress = 1.20 × [N×0.064 + S×(8+2+0.4+0.128) + C×(1.2+0.3) + 0.25]`

`External egress = 1.20 × [N×(N−1)×0.064 + S×V×(8+0.128) + C×(N−1)×1.2 + B×N×0.096 + 1]`

`Outbound GB/hour = egress Mbps × 0.45`

`Outbound TB/month = egress Mbps × hours/day × days/month × 0.00045`

The publisher-to-SFU PCM/RTC leg stays on the host and is excluded from external ingress. Its forwarded audio is included in egress. Media is never written to disk. If TURN is colocated, do not blindly double public egress: the internal SFU/relay hop is local. A separate remote TURN host introduces another provider/network leg and different billing.

## 3. Required scenarios

| Scenario | Screens / viewers | Cameras | Simultaneous effects | External ingress | External egress | Outbound per hour | 120-hour envelope |
|---|---|---:|---:|---:|---:|---:|---:|
| A — normal | 1 × 10 | 0 | 1 | 14.09 Mbps | 116.59 Mbps | 52.47 GB | 6.30 TB |
| B — busy | 2 × 10 | 0 | 2 | 26.72 Mbps | 215.86 Mbps | 97.14 GB | 11.66 TB |
| C — maximum defined | 4 × 10 | 6, each to 14 viewers | 2 | 62.79 Mbps | 531.89 Mbps | 239.35 GB | 28.72 TB |

Scenario C's original “multiple viewers” is made concrete as ten per screen; there are still only fifteen humans. This is an intentionally heavy case, with all six cameras also subscribed at high quality. A subscription-aware UI usually lowers it significantly.

Illustrative mixture: 2 hours of A + 1.5 hours of B + 0.5 hour of C daily for thirty days uses approximately **11.11 TB/month**. These are media/control envelopes that hold configured activity at the stated rate. They overstate occasional soundboard and ordinary voice activity, while attachment downloads, updates and backups add traffic. Reserve another 10% operational allowance in provider budgeting; the 20% above already covers modeled protocol overhead, so do not count it twice.

### Sensitivity

| Change to C | Estimated egress | Consequence |
|---|---:|---|
| Four streams watched by all other 14 humans | 687.95 Mbps | Approximately 37.15 TB over 120 hours |
| Screen high layer increases from 8 to 12 Mbps; ten viewers each | 723.89 Mbps | Approximately 39.09 TB over 120 hours |
| Both 12 Mbps and 14 viewers | 956.75 Mbps | No useful headroom on a nominal 1 Gbps port |
| Every stream uses 720p/30 at 2 Mbps; ten viewers, same cameras | 243.89 Mbps | Resolution/bitrate fallback materially reduces traffic |

For a particular 8 Mbps screen with two high viewers and eight at a 0.4 Mbps thumbnail layer, screen-video egress is `2×8 + 8×0.4 = 19.2 Mbps`, compared with 80 Mbps when all ten watch high. Decide separately whether those thumbnails should also receive screen audio. Hidden videos should unsubscribe. Dynacast can stop unconsumed encodings, but simulcast itself increases sender encoding/upload work. [LiveKit codecs/simulcast](https://docs.livekit.io/transport/media/advanced/), [subscriptions](https://docs.livekit.io/transport/media/subscribe/).

## 4. Client requirements and bottlenecks

A screen publisher needs roughly 12.6 Mbps upload for the assumed video layers plus audio/overhead, before its microphone/camera and other household traffic. Prefer at least 20 Mbps available upload headroom and wired connectivity for high-quality sharing. A viewer watching four high streams plus six cameras can need around 49 Mbps of receive capacity after overhead, and enough GPU/CPU for ten simultaneous video decoders. Lower subscriptions if the receiving laptop cannot decode even when its speed test is excellent.

Published internet speed, VPS port speed and measured application throughput are different. IPv4 routing, Wi-Fi interference, ISP peering, congestion, packet loss, CPU steal and TURN/TCP head-of-line blocking can be bottlenecks. Measure the actual route from users in Israel; geographic proximity is not a latency benchmark.

## 5. CPU, memory and disk

Exact vCPU consumption cannot be derived from a participant count. It depends on packet rate, codec/layer choices, retransmissions, encryption, shared-host contention and library versions. Use the following engineering budgets only to select a trial size and define failure thresholds.

| Scenario | Estimated steady total CPU across app/media | Estimated working RAM | Assessment on 4 vCPU / 8 GB |
|---|---|---|---|
| A | 0.7–1.6 vCPU | 3.0–4.5 GiB | Plausible with ample headroom; verify |
| B | 1.1–2.5 vCPU | 3.5–5.0 GiB | Plausible if CPU is not heavily contended |
| C | 2.0–4.5 vCPU | 4.5–6.5 GiB | Conditional; upper estimate exceeds four cores and leaves little reserve |

These ranges include ordinary app/DB/OS activity and up to two sound encoders. They are not measurements from LiveKit or the candidate providers. Validation work can temporarily add up to a capped 0.5 vCPU/256–512 MiB, and attachment scanning may need a separate memory allowance. Defer heavy validation/scanning under media load or move it off-host. Set thresholds on actual RSS, CPU steal and queue delay; do not rely on swap for real-time media.

Approximate RAM allocations: OS/cache 1–1.5 GiB, API 0.4–0.8, PostgreSQL 0.6–1.2, LiveKit 0.5–1.5, publisher 0.2–0.5, validator 0.25–0.5, edge/metrics 0.1–0.3. Enforce caps and preserve roughly 1.5 GiB free/reclaimable headroom; maximum allocations cannot all be treated as guaranteed reservations on an 8-GB host. Avoid a heavyweight monitoring suite or permanent antivirus daemon without revisiting RAM.

For scale context only, LiveKit publishes benchmarks on a **16-core GCP compute-optimized instance** with 720p video and different audio activity. Those tests are not a 4-vCPU VPS guarantee and cannot be linearly divided by four. Its CLI load tester uses simulated media; run load generation on separate machines. [Official benchmark setup](https://docs.livekit.io/transport/self-hosting/benchmark/).

Assume 1,000 text messages/day, approximately 3 KiB/message including a rough index/event allowance: about 1.1 GB/year before maintenance/history details. At a five-message/second burst, each send involves a handful of transactional rows and at most fourteen human recipients; media forwarding is still the dominant load. Load-test 20 durable mutations/second plus reconnect/history bursts, but do not claim measured SQL latency.

An 80-GB disk budget: OS/images 12 GB, database/events 5 GB, attachments/avatars 30 GB, sound library 0.5 GB, quarantine 2 GB, logs/metrics 3 GB, temporary backup work 5 GB, free/growth reserve 22.5 GB. Cap ordinary uploads at 10 MiB/file and aggregate attachment usage; 1 GB/day would fill the 30-GB attachment budget in a month. Raise storage or archive deliberately. A 75-GB plan needs a smaller attachment/free-space allowance; a 100-GB plan is more comfortable. Off-host backups are additional capacity.

## 6. Official hosting snapshot

Values below are the retrieved public offers, not purchased quotes. Location, term/commitment, VAT, setup fees, IPv4, backup add-ons and availability can change the final price. Keep native currencies instead of inventing an exchange rate. Latency and packet loss have **not** been measured. A port rating or “unlimited” plan does not promise unrestricted sustained throughput under all policies.

| Provider / candidate | Published resources / network | Retrieved price | Suitability / evidence caveat |
|---|---|---|---|
| OVH worldwide VPS-2, European location | 4 vCores, 8 GB, 75 GB NVMe; 1 Gbps; unlimited traffic | From **$8.50/month** | Closest low-cost pilot; disk is 5 GB below brief; prove C or cap it |
| OVH worldwide VPS-3, European location | 6 vCores, 12 GB, 100 GB NVMe; 2 Gbps; unlimited traffic | From **$12.32/month** | Preferred starting trial for extra CPU/disk/network margin |
| Hetzner CX33, Germany | 4 vCPU, 8 GB, 80 GB NVMe; 20 TB EU traffic | **€8.49/month** excl. VAT/IPv4; primary IPv4 **€0.50/month** extra | €8.99 base with IPv4; A/B fit traffic envelope, sustained C exceeds it; retrieved product page showed unavailable |
| Contabo Cloud VPS 4 | 4 vCPU, 8 GB, 100 GB SSD; **200 Mbps** port; unlimited subject to policy | US locale showed **$4.40/month**; global locale showed **$5.28/month** with a VAT-inclusive heading | Lower price but B/C exceed port; location/tax/term quote unresolved |
| Contabo Cloud VPS 6 | 6 vCPU, 12 GB, 100 GB NVMe or 200 GB SSD; **300 Mbps** port | US locale **$6.00/month**, global **$7.20/month** | B nominally fits; C does not; “more CPU” does not fix the port cap |
| Kamatera, Israeli deployment candidate | Configurable; public Pro preset is 2 vCPU/4 GB/20 GB, 5 TB | Public preset **$39/month**; exact 4-vCPU/8-GB/80-GB quote **not verified** | Do not present the preset as the requested machine; published extra traffic $0.01/GB is material |
| Interhost, Petach-Tiqwa preset | 4 CPU cores, 12 GB, 80 GB SSD; advertised 10 Gbps and 10 TB | **€326/month** displayed for Linux NGINX Cache VPS | Price/spec verified on public page, but a specialized preset and far above budget; request comparable custom quote |
| JetServer, Israel | Configurable VPS; exact requested machine/transfer must be quoted | **Not verified** from accessible dynamic calculator | No invented price; compare only after confirming CPU type, sustained outbound, transfer and protection |

Sources: [OVH current range](https://www.ovhcloud.com/en/vps/), [Hetzner configuration](https://www.hetzner.com/cloud/cost-optimized/), [Hetzner June 2026 pricing](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [IPv4](https://docs.hetzner.com/cloud/servers/primary-ips/overview/), [Contabo pricing, US](https://contabo.com/en-us/pricing/), [Contabo pricing, global](https://contabo.com/en/pricing/), [Kamatera](https://www.kamatera.com/pricing/), [Interhost](https://interhost.co.il/server-product/linux-vps/), [JetServer](https://jetserver.co.il/cloud-pricing).

OVH advertises included anti-DDoS and daily backup, but an independent backup is still required. Its APAC ranges have monthly transfer caps; the unlimited comparison here is for an eligible European deployment. Hetzner's 20 TB is an allowance, not a bandwidth guarantee; confirm current overage billing before deployment. Contabo's official pricing results and older documentation use different generation names, and live page retrieval was unreliable; the current indexed offer is useful for comparison but must be confirmed in a regional quote. Kamatera's billing page includes an incoming/outgoing ratio condition, so verify traffic accounting for the chosen region.

## 7. Cost consequences and provider decision

At $0.01/GB beyond a 5,000-GB allowance, the modeled A/B/C envelopes alone add roughly **$13 / $67 / $237 per month** to a plan with those rules, before backup/attachment allowance. This is an illustrative calculation using Kamatera's published overage rate, not an exact invoice. Inbound rules and rounding may alter it. This makes high included transfer particularly valuable for shared video.

| Recommended OVH VPS-3 budget item | Planning allowance/month |
|---|---:|
| Advertised starting VPS | $12.32 |
| Domain amortization | $1–2, estimate |
| Encrypted independent backup storage | $3–6, estimate; vendor not selected |
| Small operational contingency | $1–3, estimate |
| Total | **About $17–23**, before tax, regional/term differences and optional extras |

Recommendation is **OVH VPS-3 in a European datacentre**, subject to evening connectivity tests from Israel. Hetzner Germany is the second candidate if available and if observed usage stays inside a sensible allowance. Israeli hosting may yield a better path, but neither lower latency nor sustained bandwidth can be asserted without measurement; justify its premium with actual results. Contabo's cheapest tiers are a fit for limited video, not the specified maximum on their advertised ports.

Evaluate DDoS handling for UDP media, not only HTTP protection. Ask each shortlisted provider about sustained outbound rate, fair-use throttling, CPU sharing/steal, peak packet rate, traffic counting, IPv4 cost, region, term/renewal price, backups and DDoS incident policy. Availability claims and marketing port speeds are not reliability measurements.

## 8. Validation and expansion triggers

Run a short refundable/hourly trial where offered, without assuming any trial is free. From at least three Israeli ISP/mobile paths, measure evening RTT, jitter, loss, throughput and actual browser media over UDP and forced TURN/TLS. Initial targets: p95 network RTT under 100 ms where achievable, loss under 1%, jitter under 20 ms, and sustained available outbound above 700 Mbps for default C. Targets are acceptance goals, not geography-based predictions.

Load A/B/C for 30 minutes each and a mixed four-hour soak. Require CPU below 70–75% sustained, no material steal/throttling, at least 1.5 GiB memory headroom, no growing queues and acceptable voice/video latency. A 4-vCPU pilot can pass A/B and still fail C; then reduce subscriptions/bitrate or move to 6–8 vCPU/12–16 GB. Do not compensate for packet loss by increasing bitrate.

Expand when measured CPU/throughput or traffic budget repeatedly reaches thresholds, when attachments exceed quota, or when acceptable downtime changes. First resize/move the SFU; then separate application/database from media if needed. Multiple LiveKit nodes introduce Redis and room placement, not an automatic split of one overloaded room. Multiple API replicas require shared Data Protection keys, session validation, event distribution, presence and worker ownership; do not add a replica behind the existing in-memory coordination unchanged.
