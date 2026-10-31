"""Hangar ops monitor: the minimal alert path from docs/architecture/security-and-operations.md.

Standard library only, host network, no inbound ports. Every INTERVAL seconds it checks

  disk      storage volume usage                   >= DISK_ALERT_PERCENT (80)
  cpu       host CPU averaged over CPU_WINDOW_MIN   >= CPU_ALERT_PERCENT (75)
  memory    host RAM in use                         >= MEM_ALERT_PERCENT (90)
  traffic   this month's bytes on the uplink        >= TRAFFIC_ALERT_PERCENT (70) of TRAFFIC_MONTHLY_GB (0 = off)
  certs     days until the TLS certificate expires  <  CERT_ALERT_DAYS (14) for APP_HOST / RTC_HOST / TURN_HOST
  backup    hours since the last successful backup  >  BACKUP_MAX_AGE_HOURS (36)
  api       GET /healthz                            failing for >= API_ALERT_MIN (3) minutes
  reconcile GET /internal/watchdog/reconcile        failing for >= RECONCILE_ALERT_MIN (5) minutes

and posts to ALERT_WEBHOOK_URL when a check turns bad, every REMIND_HOURS while it stays bad, and once when it
recovers. Discord/Slack-style webhooks get JSON, ntfy (or anything else) gets plain text. The latest results are
written to STATE_DIR/status.json; counters survive restarts in STATE_DIR/state.json.

Every RESOURCE_INTERVAL seconds it also writes STATE_DIR/resources.json: CPU and memory per project service, read from
the cgroup each compose service is placed in (cgroup_parent hangar-<service>.slice; the host's /sys/fs/cgroup is
mounted read-only at CGROUP_ROOT). The API shows it on the admin System page. No Docker socket is needed.
"""

import json
import os
import shutil
import socket
import ssl
import sys
import time
import urllib.request
from datetime import datetime, timezone


def env(name, default):
    v = os.environ.get(name, "")
    return type(default)(v) if v else default


CFG = {
    "api_url": env("API_URL", "http://127.0.0.1:8080"),
    "webhook": env("ALERT_WEBHOOK_URL", ""),
    "interval": env("INTERVAL", 60),
    "remind_hours": env("REMIND_HOURS", 6.0),
    "state_dir": env("STATE_DIR", "/state"),
    "data_path": env("DATA_PATH", "/state"),  # any path on the storage volume
    "disk_pct": env("DISK_ALERT_PERCENT", 80.0),
    "cpu_pct": env("CPU_ALERT_PERCENT", 75.0),
    "cpu_window_min": env("CPU_WINDOW_MIN", 15.0),
    "mem_pct": env("MEM_ALERT_PERCENT", 90.0),
    "traffic_gb": env("TRAFFIC_MONTHLY_GB", 0.0),
    "traffic_pct": env("TRAFFIC_ALERT_PERCENT", 70.0),
    "traffic_iface": env("TRAFFIC_IFACE", ""),
    "cert_days": env("CERT_ALERT_DAYS", 14.0),
    "cert_hosts": [h for h in (os.environ.get(k, "") for k in ("APP_HOST", "RTC_HOST", "TURN_HOST")) if h],
    "cert_addr": env("CERT_CHECK_ADDR", "127.0.0.1"),
    "backup_marker": env("BACKUP_MARKER", "/backups/last-success"),
    "backup_hours": env("BACKUP_MAX_AGE_HOURS", 36.0),
    "api_min": env("API_ALERT_MIN", 3.0),
    "reconcile_min": env("RECONCILE_ALERT_MIN", 5.0),
    "proc": env("PROC_ROOT", "/proc"),
    "cgroup_root": env("CGROUP_ROOT", "/host/cgroup"),
    "resource_interval": env("RESOURCE_INTERVAL", 10),
    "instance": env("INSTANCE_NAME", "") or os.environ.get("APP_HOST", "") or socket.gethostname(),
}


def log(msg):
    print(f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {msg}", flush=True)


# ---- measurements (pure where possible) ----------------------------------------------------------------------------

def cpu_times(stat_text):
    """(busy, total) jiffies from the first line of /proc/stat."""
    parts = [int(x) for x in stat_text.splitlines()[0].split()[1:]]
    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)  # idle + iowait
    total = sum(parts[:8])  # user..steal; guest is already included in user
    return total - idle, total


def cpu_percent(prev, cur):
    busy = cur[0] - prev[0]
    total = cur[1] - prev[1]
    return 100.0 * busy / total if total > 0 else 0.0


def mem_percent(meminfo_text):
    vals = {}
    for line in meminfo_text.splitlines():
        k, _, rest = line.partition(":")
        vals[k] = int(rest.split()[0]) if rest.split() else 0
    total = vals.get("MemTotal", 0)
    return 100.0 * (total - vals.get("MemAvailable", total)) / total if total else 0.0


def service_slices(cgroup_root):
    """{service: path} for hangar-<service>.slice, under the root (cgroupfs driver) or hangar.slice (systemd driver)."""
    found = {}
    for parent in (cgroup_root, os.path.join(cgroup_root, "hangar.slice")):
        try:
            names = os.listdir(parent)
        except OSError:
            continue
        for n in names:
            if n.startswith("hangar-") and n.endswith(".slice") and os.path.isdir(os.path.join(parent, n)):
                found.setdefault(n[len("hangar-"):-len(".slice")], os.path.join(parent, n))
    return found


def cgroup_memory_bytes(current_text, stat_text):
    """Memory in use like `docker stats`: memory.current minus reclaimable inactive page cache."""
    current = int(current_text.strip())
    for line in stat_text.splitlines():
        k, _, v = line.partition(" ")
        if k == "inactive_file":
            return max(0, current - int(v))
    return current


def cgroup_cpu_usec(stat_text):
    for line in stat_text.splitlines():
        k, _, v = line.partition(" ")
        if k == "usage_usec":
            return int(v)
    return 0


def memory_limit_bytes(max_texts):
    """Sum of the containers' memory.max inside a slice; None when any of them is unlimited."""
    total = 0
    for t in max_texts:
        t = t.strip()
        if not t.isdigit():
            return None
        total += int(t)
    return total or None


def sample_services(cgroup_root, prev, now, cores):
    """[{name, cpuPercent, memoryMb, memoryLimitMb}] plus the new cpu counters. CPU is a share of the whole machine."""
    out, counters = [], {}
    for name, path in sorted(service_slices(cgroup_root).items()):
        try:
            usec = cgroup_cpu_usec(read(f"{path}/cpu.stat"))
            mem = cgroup_memory_bytes(read(f"{path}/memory.current"), read(f"{path}/memory.stat"))
            limits = [read(os.path.join(path, c, "memory.max")) for c in os.listdir(path)
                      if os.path.isfile(os.path.join(path, c, "memory.max"))]
        except (OSError, ValueError):
            continue
        counters[name] = [now, usec]
        cpu = 0.0
        if name in prev and now > prev[name][0] and usec >= prev[name][1]:
            cpu = 100.0 * (usec - prev[name][1]) / ((now - prev[name][0]) * 1e6 * cores)
        if mem == 0 and not limits:
            continue  # an empty slice: the service is not running (one-off jobs such as backup)
        limit = memory_limit_bytes(limits)
        out.append({"name": name, "cpuPercent": round(min(cpu, 100.0), 2), "memoryMb": round(mem / 2**20, 1),
                    "memoryLimitMb": round(limit / 2**20, 1) if limit else None})
    return out, counters


def default_iface(route_text):
    for line in route_text.splitlines()[1:]:
        f = line.split()
        if len(f) > 2 and f[1] == "00000000":
            return f[0]
    return None


def iface_bytes(netdev_text, iface):
    for line in netdev_text.splitlines()[2:]:
        name, _, rest = line.partition(":")
        if name.strip() == iface:
            f = rest.split()
            return int(f[0]) + int(f[8])  # rx + tx
    return None


def add_traffic(state, month, counter):
    """Accumulates monthly bytes from a raw interface counter, surviving counter resets (reboots)."""
    if state.get("month") != month:
        state.update(month=month, used=0, last=counter)
        return state
    last = state.get("last", counter)
    state["used"] = state.get("used", 0) + (counter - last if counter >= last else counter)
    state["last"] = counter
    return state


def der_not_after(der):
    """notAfter (epoch seconds) of a DER certificate: the second UTCTime/GeneralizedTime in the TBS (Validity)."""
    times = []
    i = 0
    while i < len(der) - 2 and len(times) < 2:
        tag, ln = der[i], der[i + 1]
        if (tag == 0x17 and ln == 13) or (tag == 0x18 and ln == 15):
            raw = der[i + 2:i + 2 + ln]
            if raw.endswith(b"Z") and raw[:-1].isdigit():
                text = raw.decode()
                fmt = "%y%m%d%H%M%SZ" if tag == 0x17 else "%Y%m%d%H%M%SZ"
                times.append(datetime.strptime(text, fmt).replace(tzinfo=timezone.utc).timestamp())
                i += 2 + ln
                continue
        i += 1
    if len(times) < 2:
        raise ValueError("no validity period found")
    return times[1]


def cert_days_left(host, addr, port=443, timeout=5):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # we only read the expiry; Caddy's internal CA in rehearsals is not trusted here
    with socket.create_connection((addr, port), timeout=timeout) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as tls:
            der = tls.getpeercert(binary_form=True)
    return (der_not_after(der) - time.time()) / 86400


def http_ok(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return 200 <= r.status < 300
    except Exception:
        return False


# ---- alert state machine ---------------------------------------------------------------------------------------------

def evaluate(alerts, name, bad, detail, now, remind_s):
    """Returns the message to send (or None) and updates alerts[name]."""
    a = alerts.get(name, {"bad": False, "since": None, "notified": 0})
    msg = None
    if bad and not a["bad"]:
        a = {"bad": True, "since": now, "notified": now}
        msg = f"ALERT {name}: {detail}"
    elif bad and now - a["notified"] >= remind_s:
        a["notified"] = now
        msg = f"STILL BAD {name} (since {int((now - a['since']) / 60)} min): {detail}"
    elif not bad and a["bad"]:
        a = {"bad": False, "since": None, "notified": 0}
        msg = f"RESOLVED {name}: {detail}"
    alerts[name] = a
    return msg


def failing_for(state, key, ok, now):
    """Minutes a probe has been failing continuously (0 when it is fine)."""
    if ok:
        state.pop(key, None)
        return 0.0
    state.setdefault(key, now)
    return (now - state[key]) / 60


def send(text):
    log(text)
    url = CFG["webhook"]
    if not url:
        return
    text = f"[{CFG['instance']}] {text}"
    if "discord.com/api/webhooks" in url or "hooks.slack.com" in url:
        body = json.dumps({"content": text, "text": text}).encode()
        headers = {"Content-Type": "application/json"}
    else:
        body = text.encode()
        headers = {"Content-Type": "text/plain; charset=utf-8", "Title": "Hangar alert"}
    try:
        urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method="POST"), timeout=10).close()
    except Exception as e:  # never let alert delivery kill the monitor
        log(f"webhook failed: {e}")


# ---- main loop -------------------------------------------------------------------------------------------------------

def read(path):
    with open(path) as f:
        return f.read()


def load_state():
    try:
        return json.loads(read(os.path.join(CFG["state_dir"], "state.json")))
    except Exception:
        return {}


def save(name, value):
    path = os.path.join(CFG["state_dir"], name)
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(value, f, indent=1)
    os.replace(tmp, path)


def check_once(state, now):
    p = CFG["proc"]
    results = {}

    usage = shutil.disk_usage(CFG["data_path"])
    disk = 100.0 * usage.used / usage.total
    results["disk"] = (disk >= CFG["disk_pct"], f"{disk:.0f}% used, {usage.free / 2**30:.1f} GiB free")

    cur = cpu_times(read(f"{p}/stat"))
    samples = state.setdefault("cpu_samples", [])
    if state.get("cpu_prev"):
        samples.append([now, cpu_percent(state["cpu_prev"], cur)])
    state["cpu_prev"] = list(cur)
    window = CFG["cpu_window_min"] * 60
    samples[:] = [s for s in samples if now - s[0] <= window]
    covered = samples and now - samples[0][0] >= window * 0.8
    avg = sum(s[1] for s in samples) / len(samples) if samples else 0.0
    results["cpu"] = (bool(covered) and avg >= CFG["cpu_pct"], f"{avg:.0f}% over {CFG['cpu_window_min']:.0f} min")

    mem = mem_percent(read(f"{p}/meminfo"))
    results["memory"] = (mem >= CFG["mem_pct"], f"{mem:.0f}% in use")

    if CFG["traffic_gb"] > 0:
        iface = CFG["traffic_iface"] or default_iface(read(f"{p}/net/route"))
        counter = iface_bytes(read(f"{p}/net/dev"), iface) if iface else None
        if counter is not None:
            t = add_traffic(state.setdefault("traffic", {}), datetime.now(timezone.utc).strftime("%Y-%m"), counter)
            pct = 100.0 * t["used"] / (CFG["traffic_gb"] * 2**30)
            results["traffic"] = (pct >= CFG["traffic_pct"], f"{t['used'] / 2**30:.1f} of {CFG['traffic_gb']:.0f} GiB this month ({pct:.0f}%) on {iface}")

    for host in CFG["cert_hosts"]:
        try:
            days = cert_days_left(host, CFG["cert_addr"])
            results[f"cert {host}"] = (days < CFG["cert_days"], f"expires in {days:.1f} days")
        except Exception as e:
            results[f"cert {host}"] = (True, f"could not read the certificate: {e}")

    if CFG["backup_marker"]:
        try:
            age = (now - int(read(CFG["backup_marker"]).strip())) / 3600
            results["backup"] = (age > CFG["backup_hours"], f"last successful backup {age:.1f} h ago")
        except Exception:
            results["backup"] = (True, "no successful backup recorded yet")

    api_min = failing_for(state.setdefault("down", {}), "api", http_ok(f"{CFG['api_url']}/healthz"), now)
    results["api"] = (api_min >= CFG["api_min"], f"health check failing for {api_min:.0f} min" if api_min else "healthy")
    rec_min = failing_for(state["down"], "reconcile", http_ok(f"{CFG['api_url']}/internal/watchdog/reconcile"), now)
    results["reconcile"] = (rec_min >= CFG["reconcile_min"],
                            f"authorization reconciliation failing for {rec_min:.0f} min" if rec_min else "healthy")
    return results


def main():
    os.makedirs(CFG["state_dir"], exist_ok=True)
    state = load_state()
    alerts = state.setdefault("alerts", {})
    log(f"ops monitor started (webhook {'set' if CFG['webhook'] else 'NOT set — alerts only in this log'})")
    cores = os.cpu_count() or 1
    counters, next_check = {}, 0.0
    if not service_slices(CFG["cgroup_root"]):
        log(f"no hangar-*.slice under {CFG['cgroup_root']}: per-service usage off (mount the host's /sys/fs/cgroup there)")
    while True:
        now = time.time()
        try:
            services, counters = sample_services(CFG["cgroup_root"], counters, now, cores)
            if services:
                save("resources.json", {"at": int(now), "services": services})
        except Exception as e:
            log(f"resource sample failed: {e}")
        if now >= next_check:
            next_check = now + CFG["interval"]
            try:
                results = check_once(state, now)
                for name, (bad, detail) in sorted(results.items()):
                    msg = evaluate(alerts, name, bad, detail, now, CFG["remind_hours"] * 3600)
                    if msg:
                        send(msg)
                save("status.json", {"checkedAt": int(now), "checks": {k: {"bad": b, "detail": d} for k, (b, d) in results.items()}})
                save("state.json", state)
            except Exception as e:
                log(f"check failed: {e}")
        with open("/tmp/heartbeat", "w") as f:
            f.write(str(int(now)))
        if "--once" in sys.argv:
            return
        time.sleep(max(1, min(CFG["resource_interval"], CFG["interval"])))


if __name__ == "__main__":
    main()
