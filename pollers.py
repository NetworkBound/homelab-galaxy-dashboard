#!/usr/bin/env python3
"""Inventory, extra telemetry pollers and the Prometheus telemetry panel.

Imported by ``app.py``; call ``start_new_pollers(DATA)`` with the shared
``DATA`` dict. Three things live here:

**Inventory** — the one place that answers "which machines exist?":

  ``pve_nodes()``       the configured Proxmox endpoints, each asked
                        ``/api2/json/nodes`` for the node names it actually
                        runs (a clustered endpoint contributes every node; a
                        standalone one confirms its own name). Last-good
                        answers are cached on disk so a restart during a
                        network hiccup still knows the estate.
  ``ai_servers()``      configured ``AISRV_*`` hosts plus any guest whose name
                        looks like an inference host (``AI_MARKERS``), probed
                        for Ollama + node_exporter.
  ``health_targets()``  the configured service probes, with the address
                        resolved from the live guest inventory when ``GUEST``
                        is set — a container that moves is followed instead
                        of quietly checked at its old address forever.

**Extra pollers** producing lean summaries, safe to ship on ``/api/all``:

  nodes2   - per-node vitals: cpu/mem/rootfs/load/uptime/kernel/temp
  zfs      - per-pool ZFS health: state, cap%, frag, r/w/cksum errors, scrub age
  backups  - newest vzdump/PBS backup per guest, stale(>7d) + never-backed counts
  frigate  - per-camera fps/detect/skipped, detector inference ms, rec storage + est retention
  top      - top guests by CPU and by RAM, storage pools nearing full
  certs    - TLS expiry (days left) for the configured public hostnames
  zbx2     - Zabbix version + most recent problems with host + age
  latency  - response-time trend (last/avg/min/max/spark) for the health checks
  ai_servers - Ollama / node_exporter / remote GPU readout per AI host

**Telemetry** — ``DATA["telemetry"]``: a handful of PromQL queries folded into
one small dict (IPMI watts/fans/temps, SMART, ZFS ARC, PBS freshness, UniFi
poller, Gatus SLO, LiteLLM, CrowdSec, Akvorado). Every query is optional: a
metric your Prometheus does not scrape is simply ``None``.

Every poller is a ``while True`` daemon loop whose body is fully wrapped in
try/except: one unreachable backend never affects anything else. Secrets come
only from ``config`` (environment / config.json); nothing is hardcoded or logged.
"""
import json
import os
import re
import socket
import ssl
import threading
import time
from collections import deque
from urllib.parse import urlsplit, urlunsplit

import requests

import config

DATA = {}
PVE_CONFIGURED = config.PVE_NODES
ZBX_URL, ZBX_USER, ZBX_PASS = config.ZBX_URL, config.ZBX_USER, config.ZBX_PASS
FRIGATE = config.FRIGATE_URL
PROM = config.PROM_URL
CERT_HOSTS = config.CERT_HOSTS

_lock = threading.Lock()


def bind(data):
    """Give the module the app's live DATA dict (topology, guests) to resolve names against."""
    global DATA
    DATA = data


# =========================================================================
# Inventory
# =========================================================================
NODES_TTL = 300.0        # re-ask Proxmox which nodes it has this often
NODES_RETRY = 30.0       # ...but retry this fast while we have no answer at all
AI_TTL = 60.0
HEALTH_TTL = 30.0
EMPTY_RETRY = 8.0        # the topology is empty right after a restart: retry an empty answer quickly

_disk = None


def _disk_cache():
    global _disk
    if _disk is None:
        try:
            with open(config.INVENTORY_CACHE) as fh:
                _disk = json.load(fh)
        except Exception:
            _disk = {}
    return _disk


def _disk_put(key, val):
    d = _disk_cache()
    d[key] = {"ts": time.time(), "val": val}
    try:
        tmp = config.INVENTORY_CACHE + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(d, fh)
        os.replace(tmp, config.INVENTORY_CACHE)
    except Exception as e:
        print("[inventory] cache write failed:", e, flush=True)


def _disk_get(key):
    return (_disk_cache().get(key) or {}).get("val")


_nodes = {"ts": 0.0, "val": None, "err": {}}


def pve_nodes(force=False):
    """[{node, url, token, src}] — one entry per node each endpoint REPORTS.

    The node name is what every other Proxmox call is built from
    (/nodes/<name>/status, /storage, /disks/zfs). Asking the API for it means a
    clustered endpoint yields every node with one config entry, and a typo in
    the configured name is logged instead of becoming a silent hole.
    ``src`` is "api" (discovered now), "cached" (last good) or "configured".
    """
    if not PVE_CONFIGURED:
        return []
    now = time.time()
    with _lock:
        have = _nodes["val"] is not None
        age = now - _nodes["ts"]
        if not force and have and age < NODES_TTL:
            return _nodes["val"]
        if not force and not have and age < NODES_RETRY and _nodes["ts"]:
            return _nodes["val"] or _fallback_nodes()

    out, fresh_urls = [], set()
    by_url = {}
    for n in PVE_CONFIGURED:
        by_url.setdefault(n["url"], []).append(n)
    for url, entries in by_url.items():
        tok = entries[0]["token"]
        try:
            r = requests.get(url + "/api2/json/nodes", headers={"Authorization": "PVEAPIToken=" + tok},
                             verify=False, timeout=5)
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            data = r.json().get("data")
            if data is None:
                raise RuntimeError("no data field")
            names = [d.get("node") for d in data if d.get("node")]
            if not names:
                raise RuntimeError("endpoint reports no nodes")
            for name in names:
                out.append({"node": name, "url": url, "token": tok, "src": "api"})
            for e in entries:
                if e["node"] not in names:
                    print("[inventory] pve {}: configured node {!r} is not one of {}".format(url, e["node"], names), flush=True)
            fresh_urls.add(url)
            if _nodes["err"].pop(url, None):
                print("[inventory] pve {}: node list recovered ({})".format(url, ",".join(names)), flush=True)
        except Exception as e:
            msg = (f"{type(e).__name__}: {e}")[:140]
            if _nodes["err"].get(url) != msg:      # log on change, not every tick
                print(f"[inventory] pve {url}: {msg}", flush=True)
                _nodes["err"][url] = msg

    # anything that did not answer contributes its last-good names (or its configured
    # name), so one endpoint being down does not delete half the estate
    for n in _fallback_nodes():
        if n["url"] in fresh_urls or any(o["node"] == n["node"] and o["url"] == n["url"] for o in out):
            continue
        out.append(n)

    with _lock:
        _nodes["ts"] = now
        if out:
            _nodes["val"] = out
    if any(o["src"] == "api" for o in out):
        _disk_put("pve_nodes", [{"node": o["node"], "url": o["url"]} for o in out if o["src"] == "api"])
    return out


def _fallback_nodes():
    """Cold start or a dead endpoint: the names we saw last time, else the configured names."""
    toks = {n["url"]: n["token"] for n in PVE_CONFIGURED}
    out = [{"node": c["node"], "url": c["url"], "token": toks[c["url"]], "src": "cached"}
           for c in (_disk_get("pve_nodes") or []) if c.get("url") in toks]
    for n in PVE_CONFIGURED:
        if not any(o["node"] == n["node"] and o["url"] == n["url"] for o in out):
            out.append({"node": n["node"], "url": n["url"], "token": n["token"], "src": "configured"})
    return out


def pve_node_ips():
    """management host -> node name, parsed from the endpoint URLs (the address
    this dashboard actually talks to). A cluster maps several names onto one URL;
    the first configured name wins for that host."""
    out = {}
    for n in pve_nodes():
        host = (urlsplit(n["url"]).hostname or "").strip()
        if host and host not in out:
            out[host] = n["node"]
    return out


def _topo_guests():
    """[(label, ip, node)] for every guest the topology poller has placed.
    Empty until the first topology tick — callers must treat that as unknown."""
    topo = DATA.get("topology") or {}
    out = []
    for n in topo.get("nodes") or []:
        if n.get("kind") != "guest" or not n.get("ip"):
            continue
        par = str(n.get("parent") or "")
        host = par.split(":", 1)[1] if par.startswith("pve:") else ""
        out.append((str(n.get("label") or ""), str(n["ip"]), host))
    return out


def resolve_host(label):
    """Exact (case-insensitive) guest name -> its current IP, or None.

    Exact only, deliberately: substring matching looks helpful right up until
    "zabbix" quietly resolves to zabbix-proxy."""
    want = label.strip().lower()
    for name, ip, _node in _topo_guests():
        if name.strip().lower() == want:
            return ip
    return None


_ai = {"ts": 0.0, "val": []}


def ai_servers():
    """Configured AI hosts plus guests whose name says they serve models."""
    now = time.time()
    with _lock:
        ttl = AI_TTL if _ai["val"] else EMPTY_RETRY
        if now - _ai["ts"] < ttl and _ai["ts"]:
            return _ai["val"]
    found = [dict(s) for s in config.AI_SERVERS]
    seen = {s["ip"] for s in found}
    for name, ip, node in _topo_guests():
        low = name.lower()
        if ip in seen or not any(m in low for m in config.AI_MARKERS):
            continue
        seen.add(ip)
        found.append({"name": name, "ip": ip, "node": node,
                      "ollama": f"http://{ip}:{config.AI_OLLAMA_PORT}/api/tags",
                      "node_metrics": f"http://{ip}:{config.AI_NODE_PORT}/metrics",
                      "src": "discovered"})
    for s in found:
        s.setdefault("node_metrics", s.get("node"))
    found.sort(key=lambda s: s["name"])
    with _lock:
        _ai["ts"] = now
        if found or not _ai["val"]:
            _ai["val"] = found
    return _ai["val"]


_health = {"ts": 0.0, "val": []}


def health_targets():
    """[{name, cat, url, ip, src}] with the address resolved live.

    src="inventory" means the address came from the running estate this tick;
    "pinned" means the configured URL is used as-is."""
    now = time.time()
    ttl = HEALTH_TTL if _topo_guests() else EMPTY_RETRY
    with _lock:
        if now - _health["ts"] < ttl and _health["val"]:
            return _health["val"]
    out = []
    for e in config.SERVICE_PROBES:
        url, src = e["url"], "pinned"
        parts = urlsplit(url)
        ip = parts.hostname or ""
        if e.get("guest"):
            live = resolve_host(e["guest"])
            if live:
                netloc = live + (f":{parts.port}" if parts.port else "")
                url = urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
                ip, src = live, "inventory"
        out.append({"name": e["name"], "cat": e.get("cat") or "infra", "url": url, "ip": ip, "src": src})
    # AI hosts also expose node_exporter; discovered, so it needs no catalog row
    for s in ai_servers():
        if s.get("node_metrics"):
            out.append({"name": s["name"] + "-node", "cat": "monitor", "url": s["node_metrics"],
                        "ip": s["ip"], "src": s.get("src") or "discovered"})
    with _lock:
        _health["ts"] = now
        if out:
            _health["val"] = out
    return _health["val"]


def inventory_summary():
    """What the dashboard currently believes exists, and where each fact came from."""
    nodes = pve_nodes()
    health = health_targets()
    return {
        "pve_nodes": [{"node": n["node"], "src": n["src"]} for n in nodes],
        "pve_endpoints": len({n["url"] for n in PVE_CONFIGURED}),
        "ai_servers": [{"name": s["name"], "ip": s["ip"], "src": s.get("src")} for s in ai_servers()],
        "health": [{"name": h["name"], "ip": h["ip"], "src": h["src"]} for h in health],
        "resolved": sum(1 for h in health if h["src"] != "pinned"),
        "pinned": sum(1 for h in health if h["src"] == "pinned"),
        "guests_seen": len(_topo_guests()),
    }


# =========================================================================
# GPU exporters on other machines + AI-server readout
# =========================================================================
def _parse_labels(raw):
    labels = {}
    for part in raw.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        labels[k.strip()] = v.strip().strip('"')
    return labels


_METRIC_RE = re.compile(r"^(nvidia_smi_[a-zA-Z0-9_]+)\{([^}]*)\}\s+(.+)$")


def remote_gpu_stats():
    """GPUs behind nvidia_gpu_exporter endpoints, grouped by UUID."""
    out = []
    for exporter in config.REMOTE_GPU_EXPORTERS:
        try:
            text = requests.get(exporter["url"], timeout=4).text
            by_uuid = {}
            for line in text.splitlines():
                m = _METRIC_RE.match(line)
                if not m:
                    continue
                metric, raw_labels, raw_value = m.groups()
                uuid = _parse_labels(raw_labels).get("uuid")
                if not uuid:
                    continue
                g = by_uuid.setdefault(uuid, {"uuid": uuid, "host": exporter["host"]})
                if metric == "nvidia_smi_name":
                    value = raw_value.strip().strip('"')
                else:
                    try:
                        value = float(raw_value)
                    except ValueError:
                        value = raw_value.strip().strip('"')
                g[metric] = value
            for idx, uuid in enumerate(sorted(by_uuid)):
                g = by_uuid[uuid]
                raw_name = str(g.get("nvidia_smi_name", "GPU"))
                util = float(g.get("nvidia_smi_utilization_gpu_ratio", 0) or 0)
                if util <= 1:
                    util *= 100
                out.append({
                    "index": 100 + idx, "host": exporter["host"], "uuid": uuid,
                    "name": f"{exporter['name_prefix']} {raw_name}",
                    "util": round(util, 1),
                    "mem_used": int(float(g.get("nvidia_smi_memory_used_bytes", 0) or 0) / (1024 * 1024)),
                    "mem_total": int(float(g.get("nvidia_smi_memory_total_bytes", 0) or 0) / (1024 * 1024)),
                    "temp": int(float(g.get("nvidia_smi_temperature_gpu", 0) or 0)),
                    "power": round(float(g.get("nvidia_smi_power_draw_watts", 0) or 0), 1),
                })
        except Exception as e:
            print("[remote-gpu]", exporter["host"], e, flush=True)
    return out


def ai_server_status():
    gpus = remote_gpu_stats()
    out = []
    for server in ai_servers():
        item = {"name": server["name"], "ip": server["ip"], "cat": "ai", "src": server.get("src"),
                "gpus": [g for g in gpus if g.get("host") == server["name"]]}
        try:
            r = requests.get(server["ollama"], timeout=4)
            item["ollama_up"] = r.status_code < 500
            item["models"] = len((r.json() or {}).get("models", [])) if item["ollama_up"] else 0
        except Exception:
            item["ollama_up"] = False
            item["models"] = 0
        try:
            metrics = requests.get(server["node_metrics"], timeout=4).text
            item["node_exporter_up"] = "node_uname_info" in metrics
        except Exception:
            item["node_exporter_up"] = False
        item["up"] = item["ollama_up"] or item["node_exporter_up"] or bool(item["gpus"])
        item["gpu_count"] = len(item["gpus"])
        item["gpu_mem_total"] = sum(g.get("mem_total", 0) for g in item["gpus"])
        item["gpu_mem_used"] = sum(g.get("mem_used", 0) for g in item["gpus"])
        item["gpu_util"] = round(sum(g.get("util", 0) for g in item["gpus"]) / max(len(item["gpus"]), 1), 1)
        out.append(item)
    return out


def poll_ai_servers():
    while True:
        try:
            DATA["ai_servers"] = ai_server_status()
        except Exception as e:
            print("[ai_servers]", e, flush=True)
        time.sleep(20)


# =========================================================================
# Extra pollers
# =========================================================================
def _pve_get(n, path, timeout=6):
    H = {"Authorization": f"PVEAPIToken={n['token']}"}
    r = requests.get(f"{n['url']}/api2/json{path}", headers=H, verify=False, timeout=timeout)
    return r.json().get("data")


# ---------- 1. per-node detail: cpu/mem/rootfs/load/uptime/kernel (+temp via node-exporter) ----------
def _node_temps():
    """Best-effort max hwmon temp per PVE host, from Prometheus node-exporter."""
    temps = {}
    if not PROM:
        return temps
    try:
        res = requests.get(f"{PROM}/api/v1/query",
                           params={"query": "max by (instance) (node_hwmon_temp_celsius)"}, timeout=5).json()
        ips = pve_node_ips()
        for m in res.get("data", {}).get("result", []):
            inst = m.get("metric", {}).get("instance", "")
            ip = inst.split(":")[0]
            if ip in ips:
                temps[ips[ip]] = round(float(m["value"][1]), 1)
    except Exception:
        pass
    return temps


def poll_nodes_detail():
    while True:
        try:
            temps = _node_temps()
            out = []
            for n in pve_nodes():
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
            for n in pve_nodes():
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
            for n in pve_nodes():
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
                            if key in seen: continue          # a shared PBS store shows on every node
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
    if not FRIGATE:
        return
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
    with socket.create_connection((host, port), timeout=8) as sock, \
         ctx.wrap_socket(sock, server_hostname=host) as tls:
        cert = tls.getpeercert()
    exp = ssl.cert_time_to_seconds(cert["notAfter"])
    issuer = dict(x[0] for x in cert.get("issuer", ())).get("organizationName", "")[:20]
    return round((exp - time.time()) / 86400, 1), issuer


def poll_certs():
    if not CERT_HOSTS:
        return
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
    if not ZBX_URL:
        return
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


# =========================================================================
# Telemetry: PromQL -> one small dict. Every entry is optional.
# =========================================================================
# name -> (promql, how to fold the result, label)
#   "one" : single scalar (first sample)
#   "by"  : {label -> value} keyed on the given label
TELEMETRY_QUERIES = {
    # --- out-of-band host (ipmi_exporter) ---
    "watts":        ('ipmi_dcmi_power_consumption_watts', "one", None),
    "fans":         ('ipmi_fan_speed_rpm', "by", "name"),
    "temps":        ('ipmi_temperature_celsius', "by", "name"),
    "sel":          ('ipmi_sel_logs_count', "one", None),
    # --- drives (smartctl_exporter) ---
    "smart_bad":    ('count(smartctl_device_smart_status == 0) or vector(0)', "one", None),
    "smart_hot":    ('max by (instance) (smartctl_device_temperature{temperature_type="current"})', "by", "instance"),
    "smart_worn":   ('max by (instance) (smartctl_device_percentage_used)', "by", "instance"),
    "smart_n":      ('count by (instance) (smartctl_device_smart_status)', "by", "instance"),
    # --- ZFS (node_exporter arcstats + zfs_exporter pools) ---
    "arc_hit":      ('100 * sum by (instance) (rate(node_zfs_arc_hits[5m])) / clamp_min(sum by (instance) (rate(node_zfs_arc_hits[5m]) + rate(node_zfs_arc_misses[5m])), 1)', "by", "instance"),
    "arc_size_gb":  ('sum by (instance) (node_zfs_arc_size) / 2^30', "by", "instance"),
    "pool_frag":    ('max by (pool) (zfs_pool_fragmentation_ratio) * 100', "by", "pool"),
    # --- Proxmox Backup Server (pbs_exporter) ---
    "pbs_up":       ('pbs_up', "one", None),
    "pbs_used_pct": ('100 * pbs_used / clamp_min(pbs_size, 1)', "one", None),
    "pbs_vms":      ('count(pbs_snapshot_vm_last_timestamp)', "one", None),
    "pbs_oldest_h": ('(time() - min(pbs_snapshot_vm_last_timestamp)) / 3600', "one", None),
    "pbs_stale":    ('count((time() - pbs_snapshot_vm_last_timestamp) > 48*3600) or vector(0)', "one", None),
    "pbs_unverified": ('count(pbs_snapshot_vm_last_verify == 0) or vector(0)', "one", None),
    # --- UniFi (unpoller) ---
    "ap_clients":   ('sum by (name) (unpoller_device_stations{type="uap"})', "by", "name"),
    "clients":      ('sum(unpoller_device_stations{type="uap"})', "one", None),
    "wan_rx_mbps":  ('8 * sum(rate(unpoller_device_wan_receive_bytes_total[2m])) / 1e6', "one", None),
    "wan_tx_mbps":  ('8 * sum(rate(unpoller_device_wan_transmit_bytes_total[2m])) / 1e6', "one", None),
    # --- Gatus / public SLO ---
    "slo_ok":       ('sum(gatus_results_endpoint_success)', "one", None),
    "slo_total":    ('count(gatus_results_endpoint_success)', "one", None),
    "slo_down":     ('gatus_results_endpoint_success == 0', "by", "name"),
    "slo_24h":      ('100 * avg(avg_over_time(gatus_results_endpoint_success[24h]))', "one", None),
    # --- AI gateway (LiteLLM) ---
    "llm_inflight": ('sum(litellm_in_flight_requests) or vector(0)', "one", None),
    "llm_req_h":    ('sum(increase(litellm_proxy_total_requests_metric_total[1h])) or vector(0)', "one", None),
    "llm_tok_h":    ('sum(increase(litellm_total_tokens_metric_total[1h])) or vector(0)', "one", None),
    "llm_models":   ('sum by (model) (increase(litellm_requests_metric_total[1h])) > 0', "by", "model"),
    # --- CrowdSec (prometheus endpoint of the agent) ---
    "cs_alerts_h":  ('sum(increase(cs_alerts[1h])) or vector(0)', "one", None),
    "cs_by_scn":    ('sum by (reason) (increase(cs_alerts[24h])) > 0', "by", "reason"),
    "cs_banned":    ('sum(cs_active_decisions) or vector(0)', "one", None),
    "cs_lines_m":   ('sum(rate(cs_parser_hits_ok_total[5m])) * 60 or vector(0)', "one", None),
    # --- Akvorado flows ---
    "flows_pps":    ('sum(rate(akvorado_inlet_flow_input_udp_packets_total[5m]))', "one", None),
    "flows_fps":    ('sum(rate(akvorado_outlet_core_forwarded_flows_total[5m]))', "one", None),
    "flows_err":    ('sum(increase(akvorado_outlet_core_flows_errors_total[1h])) or vector(0)', "one", None),
}


def _q(expr):
    r = requests.get(f"{PROM}/api/v1/query", params={"query": expr}, timeout=6).json()
    if r.get("status") != "success": return None
    return r["data"]["result"]


def _fold(res, how, label):
    if not res: return None if how == "one" else {}
    if how == "one":
        try: return round(float(res[0]["value"][1]), 2)
        except Exception: return None
    out = {}
    for s in res:
        k = s["metric"].get(label, "?")
        try: out[k] = round(float(s["value"][1]), 2)
        except Exception: pass
    return out


def _short_host(instance):
    """"10.0.0.10:9633" -> the Proxmox node name that lives at that address, else as-is."""
    return pve_node_ips().get(str(instance).split(":")[0], instance)


def poll_telemetry():
    if not PROM:
        return
    while True:
        t = {"ts": time.time(), "up": False}
        try:
            up = _q('count(up == 1)')
            t["up"] = bool(up)
            t["targets_up"] = _fold(up, "one", None)
            t["targets"] = _fold(_q('count(up)'), "one", None)
            for k, (expr, how, label) in TELEMETRY_QUERIES.items():
                try: t[k] = _fold(_q(expr), how, label)
                except Exception: t[k] = None
            for k in ("smart_hot", "smart_worn", "smart_n", "arc_hit", "arc_size_gb"):
                if isinstance(t.get(k), dict):
                    t[k] = {_short_host(i): v for i, v in t[k].items()}
            f = t.get("fans") or {}
            if f: t["fan_min"], t["fan_max"] = min(f.values()), max(f.values())
            tp = t.get("temps") or {}
            t["inlet_c"] = next((v for n, v in tp.items() if "inlet" in n.lower()), None)
            t["cpu_c"] = max([v for n, v in tp.items() if n.lower().startswith("temp") or "cpu" in n.lower()] or [None]) if tp else None
        except Exception as e:
            t["err"] = str(e)[:120]
        DATA["telemetry"] = t
        time.sleep(20)


NEW_KEYS = ("nodes2", "zfs", "backups", "frigate", "top", "certs", "zbx2", "latency", "telemetry", "ai_servers")
_NEW_POLLERS = (poll_nodes_detail, poll_zfs_detail, poll_backups, poll_frigate, poll_top, poll_certs,
                poll_zbx_recent, poll_latency, poll_telemetry, poll_ai_servers)


def start_new_pollers(data=None):
    """Launch all extra pollers as daemon threads, sharing app.py's DATA dict."""
    if data is not None:
        bind(data)
    for k in NEW_KEYS: DATA.setdefault(k, None)
    for fn in _NEW_POLLERS:
        threading.Thread(target=fn, daemon=True, name="pollers-" + fn.__name__).start()
