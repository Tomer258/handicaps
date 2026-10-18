"""Host sampler for load tests (runbooks/load-test.md). Run ON the Hangar host while load-test.sh runs elsewhere.

Every 5 s records CPU busy %, CPU steal %, MemAvailable and the default interface's rx/tx Mbps to a CSV, then prints
a summary against capacity-and-hosting.md §8:  p95 CPU <= 75 %, p95 steal < 5 % ("no material steal"),
min MemAvailable >= 1.5 GiB. Egress is reported next to the modelled value for the scenario (informational: the
simulated clients only approximate the model's subscriptions).

Usage: python3 -I infra/scripts/load-sample.py --scenario A --minutes 30 [--out /srv/hangar/loadtest/A.csv]
       python3 -I infra/scripts/load-sample.py --self-test
Exit 0 = criteria met, 1 = not met.
"""

import argparse
import csv
import sys
import time

MODEL_EGRESS_MBPS = {"A": 116.59, "B": 215.86, "C": 531.89, "SOAK": None}
MAX_P95_CPU = 75.0
MAX_P95_STEAL = 5.0
MIN_MEM_GIB = 1.5


def cpu_fields(stat_text):
    """(total, idle incl. iowait, steal) jiffies from the aggregate 'cpu' line of /proc/stat."""
    parts = stat_text.splitlines()[0].split()
    assert parts[0] == "cpu"
    v = [int(x) for x in parts[1:]]
    v += [0] * (8 - len(v))
    user, nice, system, idle, iowait, irq, softirq, steal = v[:8]
    total = user + nice + system + idle + iowait + irq + softirq + steal  # guest is already inside user/nice
    return total, idle + iowait, steal


def cpu_percents(a, b):
    """(busy %, steal %) between two cpu_fields samples. Steal counts as not-busy-for-us but is reported separately."""
    dt = b[0] - a[0]
    if dt <= 0:
        return 0.0, 0.0
    idle = b[1] - a[1]
    steal = b[2] - a[2]
    return round(100.0 * (dt - idle - steal) / dt, 1), round(100.0 * steal / dt, 1)


def mem_available_gib(meminfo_text):
    for line in meminfo_text.splitlines():
        if line.startswith("MemAvailable:"):
            return round(int(line.split()[1]) / 1024 / 1024, 2)
    raise ValueError("MemAvailable missing")


def default_iface(route_text):
    for line in route_text.splitlines()[1:]:
        f = line.split()
        if len(f) > 2 and f[1] == "00000000":
            return f[0]
    return None


def iface_rx_tx(dev_text, iface):
    for line in dev_text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        if name.strip() == iface:
            f = rest.split()
            return int(f[0]), int(f[8])
    raise ValueError(f"interface {iface} not found")


def p95(values):
    s = sorted(values)
    return s[min(len(s) - 1, int(round(0.95 * (len(s) - 1))))] if s else 0.0


def summarize(rows, scenario):
    cpu = [r["cpu"] for r in rows]
    steal = [r["steal"] for r in rows]
    mem = [r["mem_gib"] for r in rows]
    tx = [r["tx_mbps"] for r in rows]
    out = {
        "samples": len(rows),
        "cpu_p95": p95(cpu), "cpu_max": max(cpu, default=0.0),
        "steal_p95": p95(steal), "steal_max": max(steal, default=0.0),
        "mem_min_gib": min(mem, default=0.0),
        "tx_avg_mbps": round(sum(tx) / len(tx), 1) if tx else 0.0, "tx_p95_mbps": p95(tx),
        "rx_avg_mbps": round(sum(r["rx_mbps"] for r in rows) / len(rows), 1) if rows else 0.0,
        "model_egress_mbps": MODEL_EGRESS_MBPS.get(scenario),
    }
    out["failures"] = [msg for ok, msg in [
        (out["cpu_p95"] <= MAX_P95_CPU, f"p95 CPU {out['cpu_p95']}% > {MAX_P95_CPU}%"),
        (out["steal_p95"] < MAX_P95_STEAL, f"p95 steal {out['steal_p95']}% >= {MAX_P95_STEAL}% (noisy neighbour / throttled vCPU)"),
        (out["mem_min_gib"] >= MIN_MEM_GIB, f"MemAvailable fell to {out['mem_min_gib']} GiB < {MIN_MEM_GIB} GiB"),
    ] if not ok]
    return out


def read(path):
    with open(path, encoding="ascii") as f:
        return f.read()


def run(scenario, minutes, out_path, interval=5.0):
    iface = default_iface(read("/proc/net/route"))
    if not iface:
        sys.exit("no default route")
    rows = []
    prev_cpu, prev_net, prev_t = cpu_fields(read("/proc/stat")), iface_rx_tx(read("/proc/net/dev"), iface), time.monotonic()
    end = prev_t + minutes * 60
    with open(out_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["utc", "cpu_pct", "steal_pct", "mem_available_gib", "rx_mbps", "tx_mbps"])
        while time.monotonic() < end:
            time.sleep(interval)
            cpu, net, t = cpu_fields(read("/proc/stat")), iface_rx_tx(read("/proc/net/dev"), iface), time.monotonic()
            busy, steal = cpu_percents(prev_cpu, cpu)
            secs = t - prev_t
            rx = round((net[0] - prev_net[0]) * 8 / secs / 1e6, 1)
            tx = round((net[1] - prev_net[1]) * 8 / secs / 1e6, 1)
            row = {"cpu": busy, "steal": steal, "mem_gib": mem_available_gib(read("/proc/meminfo")), "rx_mbps": rx, "tx_mbps": tx}
            rows.append(row)
            w.writerow([time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), busy, steal, row["mem_gib"], rx, tx])
            f.flush()
            print(f"\rcpu {busy:5.1f}%  steal {steal:4.1f}%  mem {row['mem_gib']:5.2f} GiB  tx {tx:7.1f} Mbps  rx {rx:6.1f} Mbps", end="", flush=True)
            prev_cpu, prev_net, prev_t = cpu, net, t
    print()
    s = summarize(rows, scenario)
    for k, v in s.items():
        if k != "failures":
            print(f"{k:>18}: {v}")
    print("RESULT:", "PASS" if not s["failures"] else "FAIL — " + "; ".join(s["failures"]))
    return 0 if not s["failures"] else 1


def self_test():
    a = cpu_fields("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1")
    b = cpu_fields("cpu  250 0 150 800 100 0 0 50 0 0\n")
    assert cpu_percents(a, b) == (57.1, 14.3), cpu_percents(a, b)  # Δtotal 350: busy 200, steal 50
    assert mem_available_gib("MemTotal: 8388608 kB\nMemAvailable: 2097152 kB\n") == 2.0
    assert default_iface("Iface\tDestination\tGateway\neth0\t0000FEA9\t00000000\nens3\t00000000\t0101A8C0\n") == "ens3"
    assert iface_rx_tx("h1\nh2\n  ens3: 1000 5 0 0 0 0 0 0 2000 7 0 0 0 0 0 0\n", "ens3") == (1000, 2000)
    assert p95(list(range(1, 101))) == 95
    rows = [{"cpu": 60.0, "steal": 1.0, "mem_gib": 3.0, "rx_mbps": 10.0, "tx_mbps": 100.0}] * 18 + \
           [{"cpu": 90.0, "steal": 1.0, "mem_gib": 1.2, "rx_mbps": 10.0, "tx_mbps": 120.0}] * 2  # the top 10 %
    s = summarize(rows, "A")
    assert s["cpu_p95"] == 90.0 and s["mem_min_gib"] == 1.2 and len(s["failures"]) == 2, s
    assert summarize(rows[:18], "A")["failures"] == []
    print("self-test ok")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=sorted(MODEL_EGRESS_MBPS), default="A")
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--out")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        sys.exit(self_test())
    sys.exit(run(args.scenario, args.minutes, args.out or f"loadtest-{args.scenario}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.csv"))
