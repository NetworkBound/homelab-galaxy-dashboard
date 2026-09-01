#!/usr/bin/env python3
"""Extra telemetry pollers for the dashboard.

Self-contained: can be `import`ed as a module (call start_new_pollers(DATA)
passing app.py's DATA dict) or appended verbatim to app.py (then the shared
DATA / PVE_NODES / ZBX_* / FRIGATE / PROM globals are reused automatically
and start_new_pollers() needs no argument).

New DATA keys produced (all lean summaries, safe to ship on /api/all):
  nodes2   - per-PVE-node vitals: cpu/mem/rootfs/load/uptime/kernel/temp
  zfs      - per-pool ZFS health: state, cap%, frag, r/w/cksum errors, scrub age
  backups  - newest vzdump/PBS backup per guest, stale(>7d) + never-backed counts
  frigate  - per-camera fps/detect/skipped, detector inference ms, rec storage + est retention
  top      - top guests by CPU and by RAM, storage pools nearing full
  certs    - TLS expiry (days left) for the public hostnames
  zbx2     - Zabbix version + most recent problems with host + age
  latency  - response-time trend (last/avg/min/max/spark) for the HEALTH checks

Every poller is a `while True` daemon loop whose body is fully wrapped in
try/except: one unreachable backend never affects anything else.
Secrets come ONLY from os.environ; nothing is ever hardcoded or logged.
"""
import os, re, ssl, socket, time, threading
from collections import deque
import requests

import config

# ---- shared config: reuse app.py's globals when appended, else read config.py ----
if "DATA" not in globals():
    DATA = {}
if "PVE_NODES" not in globals():
    PVE_NODES = config.PVE_NODES
if "ZBX_URL" not in globals():
    ZBX_URL = config.ZBX_URL
    ZBX_USER, ZBX_PASS = config.ZBX_USER, config.ZBX_PASS
if "FRIGATE" not in globals():
    FRIGATE = config.FRIGATE_URL
if "PROM" not in globals():
    PROM = config.PROM_URL

# Public TLS endpoints to watch expiry on. Hostnames only, never secrets.
# Set NP_CERT_HOSTS="host[:port],host2[:port],..." — empty means the cert panel
# is simply not populated.
CERT_HOSTS = [h.strip() for h in os.environ.get("NP_CERT_HOSTS", "").split(",") if h.strip()]


def _pve_get(n, path, timeout=6):
    H = {"Authorization": f"PVEAPIToken={n['token']}"}
    r = requests.get(f"{n['url']}/api2/json{path}", headers=H, verify=False, timeout=timeout)
    return r.json().get("data")


# ---------- 1. per-node detail: cpu/mem/rootfs/load/uptime/kernel (+temp via node-exporter) ----------
def _node_temps():
    """Best-effort max hwmon temp per PVE host, from Prometheus node-exporter."""
    temps = {}
    try:
        res = requests.get(f"{PROM}/api/v1/query",
                           params={"query": "max by (instance) (node_hwmon_temp_celsius)"}, timeout=5).json()
        for m in res.get("data", {}).get("result", []):
            inst = m.get("metric", {}).get("instance", "")
            ip = inst.split(":")[0]
            for n in PVE_NODES:
                if ip and ip in n["url"]:
                    temps[n["node"]] = round(float(m["value"][1]), 1)
    except Exception:
        pass
    return temps

def poll_nodes_detail():
    while True:
        try:
            temps = _node_temps()
            out = []
            for n in PVE_NODES:
                try:
                    st = _pve_get(n, f"/nodes/{n['node']}/status") or {}
                    mem = st.get("memory", {}) or {}
                    rfs = st.get("rootfs", {}) or {}
                    la = st.get("loadavg", [0, 0, 0]) or [0, 0, 0]
                    kv = (st.get("current-kernel", {}) or {}).get("release") or st.get("kversion", "")
                    m = re.search(r"\d+\.\d+[^\s]*", kv)
                    out.append({"node": n["node"], "cpu": round(st.get("cpu", 0) * 100, 1),
                        "cores": (st.get("cpuinfo", {}) or {}).get("cpus", 0),
                        "load": [round(float(x), 2) for x in la[:3]],
                        "mem_used": mem.get("used", 0), "mem_total": mem.get("total", 1),
                        "mem_pct": round(mem.get("used", 0) / max(mem.get("total", 1), 1) * 100, 1),
                        "rootfs_used": rfs.get("used", 0), "rootfs_total": rfs.get("total", 1),
                        "rootfs_pct": round(rfs.get("used", 0) / max(rfs.get("total", 1), 1) * 100, 1),
                        "uptime": st.get("uptime", 0), "kernel": m.group(0) if m else kv[:24],
                        "temp": temps.get(n["node"])})
                except Exception as e:
                    print("[nodes2]", n["node"], e, flush=True)
            if out: DATA["nodes2"] = out
        except Exception as e:
            print("[nodes2]", e, flush=True)
        time.sleep(20)


# ---------- 2. ZFS pool health detail: errors + scrub state/age, loud on DEGRADED ----------
def _zfs_sum_errs(children, acc):
    for c in children or []:
        acc[0] += int(c.get("read", 0) or 0); acc[1] += int(c.get("write", 0) or 0)
        acc[2] += int(c.get("cksum", 0) or 0)
        if c.get("children"): _zfs_sum_errs(c["children"], acc)
    return acc

def poll_zfs_detail():
    while True:
        try:
            out = []
            for n in PVE_NODES:
                try:
                    for p in _pve_get(n, f"/nodes/{n['node']}/disks/zfs") or []:
                        row = {"node": n["node"], "name": p.get("name"), "state": p.get("health", "?"),
                               "cap": round(p.get("alloc", 0) / max(p.get("size", 1), 1) * 100, 1),
                               "frag": p.get("frag", 0), "size": p.get("size", 0), "free": p.get("free", 0)}
                        try:
                            d = _pve_get(n, f"/nodes/{n['node']}/disks/zfs/{p['name']}") or {}
                            row["state"] = d.get("state", row["state"])
                            errs = _zfs_sum_errs(d.get("children"), [0, 0, 0])
                            row["errs"] = {"r": errs[0], "w": errs[1], "c": errs[2]}
                            scan = d.get("scan") or ""
                            row["scrub"] = (not scan and "never") or ("in progress" in scan and "running") or \
                                           ("repaired" in scan and "0 errors" in scan and "clean") or \
                                           ("none" in scan and "never") or "check"
                            m = re.search(r"on (\w{3} \w{3} +\d+ [\d:]+ \d{4})", scan)
                            if m:
                                try:
                                    ts = time.mktime(time.strptime(m.group(1).replace("  ", " "), "%a %b %d %H:%M:%S %Y"))
                                    row["scrub_age_d"] = round((time.time() - ts) / 86400, 1)
                                except Exception: pass
                        except Exception: pass
                        row["bad"] = row["state"] not in ("ONLINE",) or any((row.get("errs") or {}).values())
                        out.append(row)
                except Exception as e:
                    print("[zfs]", n["node"], e, flush=True)
            if out: DATA["zfs"] = out
        except Exception as e:
            print("[zfs]", e, flush=True)
        time.sleep(60)


# ---------- 3. backups: newest vzdump/PBS backup per guest; stale >7d and never-backed counts ----------
def poll_backups():
    while True:
        try:
            latest = {}          # vmid -> newest ctime
            stores, seen = set(), set()
            for n in PVE_NODES:
                try:
                    for s in _pve_get(n, f"/nodes/{n['node']}/storage") or []:
                        if "backup" not in (s.get("content") or "") or not s.get("active", 1): continue
                        sid = s["storage"]
                        try:
                            items = _pve_get(n, f"/nodes/{n['node']}/storage/{sid}/content?content=backup", timeout=20) or []
                        except Exception:
                            continue
                        stores.add(sid)
                        for it in items:
                            key = it.get("volid")
                            if key in seen: continue          # shared PBS store shows on both nodes
                            seen.add(key)
                            vd, ct = it.get("vmid"), it.get("ctime", 0)
                            if vd and ct and ct > latest.get(int(vd), 0): latest[int(vd)] = ct
                except Exception as e:
                    print("[backups]", n["node"], e, flush=True)
            guests = DATA.get("guests") or []
            now = time.time()
            summ = {"storages": sorted(stores), "archives": len(seen), "ts": int(now)}
            if guests:
                worst = []
                stale = missing = 0
                for g in guests:
                    ct = latest.get(int(g["id"])) if g.get("id") is not None else None
                    if not ct:
                        missing += 1; worst.append({"id": g["id"], "name": g["name"], "age_d": None})
                    else:
                        age = (now - ct) / 86400
                        if age > 7:
                            stale += 1; worst.append({"id": g["id"], "name": g["name"], "age_d": round(age, 1)})
                worst.sort(key=lambda w: (-1e9 if w["age_d"] is None else -w["age_d"]))
                newest = max(latest.values()) if latest else 0
                summ.update({"guests": len(guests), "backed": len(guests) - missing, "stale7": stale,
                             "missing": missing, "worst": worst[:8],
                             "newest_age_h": round((now - newest) / 3600, 1) if newest else None})
            DATA["backups"] = summ
        except Exception as e:
            print("[backups]", e, flush=True)
        time.sleep(900)


# ---------- 4. Frigate detail: per-cam fps, detector inference, recording storage + retention ----------
_fr_hist = deque(maxlen=96)      # (ts, used_mb) samples -> growth rate -> est retention days
def poll_frigate():
    while True:
        try:
            st = requests.get(f"{FRIGATE}/api/stats", timeout=6).json()
            cams = []
            for name, c in sorted((st.get("cameras") or {}).items()):
                cams.append({"name": name, "fps": round(c.get("camera_fps", 0), 1),
                             "dfps": round(c.get("detection_fps", 0), 1),
                             "skip": round(c.get("skipped_fps", 0), 1)})
            dets = {k: round(v.get("inference_speed", 0), 1) for k, v in (st.get("detectors") or {}).items()}
            stor = ((st.get("service") or {}).get("storage") or {})
            rec = stor.get("/media/frigate/recordings") or next(iter(stor.values()), {}) or {}
            used, total = float(rec.get("used", 0) or 0), float(rec.get("total", 1) or 1)   # MB
            free = float(rec.get("free", total - used) or 0)
            now = time.time(); _fr_hist.append((now, used))
            est = None
            if len(_fr_hist) > 3 and now - _fr_hist[0][0] > 900:
                rate = (used - _fr_hist[0][1]) / (now - _fr_hist[0][0]) * 86400   # MB/day
                if rate > 1: est = round(free / rate, 1)
            DATA["frigate"] = {"up": True, "cams": cams, "det_ms": dets,
                "rec": {"used_gb": round(used / 1024, 1), "total_gb": round(total / 1024, 1),
                        "pct": round(used / max(total, 1) * 100, 1), "est_days": est},
                "version": (st.get("service") or {}).get("version", "")[:16]}
        except Exception as e:
            DATA["frigate"] = (DATA.get("frigate") if isinstance(DATA.get("frigate"), dict) else None) or {"up": False}
            DATA["frigate"]["err"] = str(e)[:60]; DATA["frigate"]["up"] = False
        time.sleep(15)


# ---------- 5. top talkers + capacity: derived from already-polled DATA, no new requests ----------
def poll_top():
    while True:
        try:
            run = [g for g in (DATA.get("guests") or []) if g.get("status") == "running"]
            cpu = sorted(run, key=lambda g: -g.get("cpu", 0))[:5]
            mem = sorted(run, key=lambda g: -g.get("mem", 0))[:5]
            full = [{"name": s["name"], "node": s["node"], "pct": s["pct"]}
                    for s in (DATA.get("storage") or []) if s.get("pct", 0) >= 80]
            for p in (DATA.get("zfs") or []):
                if p.get("cap", 0) >= 80: full.append({"name": p["name"], "node": p["node"], "pct": p["cap"]})
            DATA["top"] = {
                "cpu": [{"name": g["name"][:16], "node": g["node"], "v": g["cpu"]} for g in cpu],
                "mem": [{"name": g["name"][:16], "node": g["node"], "gb": round(g["mem"] / 1.074e9, 1),
                         "pct": round(g["mem"] / max(g["maxmem"], 1) * 100)} for g in mem],
                "full": sorted(full, key=lambda x: -x["pct"])[:5]}
        except Exception as e:
            print("[top]", e, flush=True)
        time.sleep(12)


# ---------- 6. TLS certificate expiry for the public hostnames (warn <21d) ----------
def _cert_days(host, port=443):
    ctx = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=8) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as tls:
            cert = tls.getpeercert()
    exp = ssl.cert_time_to_seconds(cert["notAfter"])
    issuer = dict(x[0] for x in cert.get("issuer", ())).get("organizationName", "")[:20]
    return round((exp - time.time()) / 86400, 1), issuer

def poll_certs():
    while True:
        try:
            out = []
            for spec in CERT_HOSTS:
                host, _, port = spec.partition(":")
                try:
                    days, issuer = _cert_days(host, int(port or 443))
                    out.append({"host": host, "days": days, "issuer": issuer,
                                "state": "crit" if days < 7 else "warn" if days < 21 else "ok"})
                except Exception as e:
                    out.append({"host": host, "days": None, "state": "err", "err": str(e)[:40]})
            out.sort(key=lambda c: (c["days"] is None, c["days"] if c["days"] is not None else 0))
            DATA["certs"] = {"hosts": out, "min_days": next((c["days"] for c in out if c["days"] is not None), None),
                             "warn": sum(1 for c in out if c["state"] in ("warn", "crit", "err")), "ts": int(time.time())}
        except Exception as e:
            print("[certs]", e, flush=True)
        time.sleep(1800)


# ---------- 7. Zabbix rollup: API version + most recent problems with host + age ----------
def poll_zbx_recent():
    while True:
        try:
            # apiinfo.version MUST be called without the Authorization header (Zabbix >= 6.4)
            ver = ""
            try:
                ver = requests.post(ZBX_URL, json={"jsonrpc": "2.0", "method": "apiinfo.version",
                                                   "params": {}, "id": 1}, timeout=8).json().get("result", "")
            except Exception: pass
            tok = requests.post(ZBX_URL, json={"jsonrpc": "2.0", "method": "user.login",
                "params": {"username": ZBX_USER, "password": ZBX_PASS}, "id": 1}, timeout=8).json().get("result")
            if not tok:
                DATA["zbx2"] = {"version": ver, "error": "auth"}; time.sleep(60); continue
            H = {"Authorization": f"Bearer {tok}"}
            probs = requests.post(ZBX_URL, headers=H, json={"jsonrpc": "2.0", "method": "problem.get",
                "params": {"output": ["eventid", "name", "severity", "clock", "objectid"], "severities": [1, 2, 3, 4, 5],
                           "suppressed": False, "sortfield": ["eventid"], "sortorder": "DESC", "limit": 20},
                "id": 2}, timeout=8).json().get("result", [])
            tmap = {}
            trigids = list({p["objectid"] for p in probs if p.get("objectid")})
            if trigids:
                trg = requests.post(ZBX_URL, headers=H, json={"jsonrpc": "2.0", "method": "trigger.get",
                    "params": {"triggerids": trigids, "monitored": True, "selectHosts": ["host"],
                               "output": ["triggerid"]}, "id": 3}, timeout=8).json().get("result", [])
                for t in trg: tmap[t["triggerid"]] = (t["hosts"][0]["host"] if t.get("hosts") else None)
            now = time.time()
            recent = [{"host": tmap[p["objectid"]][:18], "name": p.get("name", "")[:48],
                       "sev": int(p.get("severity", 0)), "age": int(now - int(p.get("clock", now)))}
                      for p in probs if tmap.get(p.get("objectid"))][:8]
            DATA["zbx2"] = {"version": ver, "recent": recent}
        except Exception as e:
            DATA["zbx2"] = {"error": str(e)[:60]}
        time.sleep(60)


# ---------- 8. service latency trend: rolling window over the existing HEALTH results ----------
_lat = {}    # name -> deque of ms
def poll_latency():
    while True:
        try:
            out = []
            for h in (DATA.get("health") or []):
                dq = _lat.setdefault(h["name"], deque(maxlen=30))
                if h.get("up"): dq.append(int(h.get("ms", 0)))
                if not dq: continue
                out.append({"name": h["name"], "cat": h.get("cat"), "up": h.get("up"),
                            "last": dq[-1], "avg": int(sum(dq) / len(dq)), "min": min(dq), "max": max(dq),
                            "spark": list(dq)[-20:]})
            if out: DATA["latency"] = out
        except Exception as e:
            print("[latency]", e, flush=True)
        time.sleep(20)


NEW_KEYS = ("nodes2", "zfs", "backups", "frigate", "top", "certs", "zbx2", "latency")
_NEW_POLLERS = (poll_nodes_detail, poll_zfs_detail, poll_backups, poll_frigate,
                poll_top, poll_certs, poll_zbx_recent, poll_latency)

def start_new_pollers(data=None):
    """Launch all extra pollers as daemon threads.

    When this file is imported as a module, pass app.py's DATA dict so both
    sides share one cache; when appended into app.py, call with no argument.
    """
    global DATA
    if data is not None: DATA = data
    for k in NEW_KEYS: DATA.setdefault(k, None)
    for fn in _NEW_POLLERS:
        threading.Thread(target=fn, daemon=True).start()
