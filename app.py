#!/usr/bin/env python3
"""Homelab Galaxy — a cinematic, GPU-accelerated 3D monitoring console.

Every guest in your Proxmox cluster becomes a lit planet, each node a spiral
galaxy, storage pools ringed worlds, and cameras orbiting satellites. All of it
is driven by live data polled in the background from Proxmox, Zabbix, UniFi,
Frigate, Prometheus, ntopng, your internet edge and friends.

Configuration lives in ``config.py`` and is resolved from the environment,
``config.json`` (written by the browser setup wizard at ``/setup``) and
defaults; see ``.env.example`` and ``docs/configuration.md``. Any data source
you leave unconfigured is skipped, and the dashboard renders without that layer.

Three ways to run it:

    DEMO=1 python3 app.py        # everything from demo/fixtures, no network at all
    python3 app.py               # nothing configured -> prints a token, serves /setup
    set -a; . ./.env; python3 app.py

Modules: ``pollers`` (inventory + extra pollers + telemetry), ``topology``
(network tree + flows), ``probe`` (fping), ``edge`` (tunnel/CrowdSec/Akvorado),
``threats`` (security + audience + unified timeline), ``showtime`` (Ollama /
Frigate / Emby feeds, display modes, presence), ``addons`` (panels dropped into
``addons/``), ``setup`` (wizard API), ``demo`` (fixture feed).
"""
import json
import os
import socket
import sqlite3
import threading
import time

import requests
import urllib3
from flask import Flask, Response, jsonify, redirect, render_template, request
from jinja2 import TemplateNotFound

import config
import pollers

urllib3.disable_warnings()

HERE = os.path.dirname(os.path.abspath(__file__))

# --- resolved configuration (see config.py / .env.example) ---
OLLAMA = config.OLLAMA_URL
OLLAMA_MODEL = config.OLLAMA_MODEL
FRIGATE = config.FRIGATE_URL
ZBX_URL = config.ZBX_URL
ZBX_USER, ZBX_PASS = config.ZBX_USER, config.ZBX_PASS
UNIFI = config.UNIFI_URL
UNIFI_USER, UNIFI_PASS, UNIFI_SITE = config.UNIFI_USER, config.UNIFI_PASS, config.UNIFI_SITE or "default"
GRAFANA = config.GRAFANA_URL
GRAFANA_TOKEN = config.GRAFANA_TOKEN
GRAFANA_HEADERS = {"Authorization": "Bearer " + GRAFANA_TOKEN} if GRAFANA_TOKEN else {}
PROM = config.PROM_URL
NETMAP_URL = config.NETMAP_URL
PVE_NODES = config.PVE_NODES
CATS = config.CATEGORIES            # category -> keywords (config.json ui.categories merges over the defaults)
categorize = config.categorize

# Optional NVIDIA telemetry. Absent GPU / absent driver must not stop the app.
_NGPU = 0
pynvml = None
gpu_render = None
if config.ENABLE_GPU and not config.DEMO:
    try:
        import pynvml
        pynvml.nvmlInit()
        _NGPU = pynvml.nvmlDeviceGetCount()
    except Exception as e:          # no NVIDIA card, no driver, or inside a CT without passthrough
        print("[gpu] NVML unavailable, GPU panels disabled:", e, flush=True)
        pynvml = None
if config.ENABLE_GPU_RENDER and not config.DEMO:
    try:
        import gpu_render
    except Exception as e:
        print("[gpu] server-side EGL render unavailable:", e, flush=True)
        gpu_render = None

app = Flask(__name__)
# Without this, Jinja keeps the compiled template from service start and every
# later edit to the pages is invisible until a restart.
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True

remote_gpu_stats = pollers.remote_gpu_stats


def gpu_stats():
    if config.DEMO:
        return list((DATA.get("gpu") or {}).get("gpus") or [])
    if pynvml is None or _NGPU == 0:
        return remote_gpu_stats()
    out = []
    for i in range(_NGPU):
        h = pynvml.nvmlDeviceGetHandleByIndex(i)
        m = pynvml.nvmlDeviceGetMemoryInfo(h); u = pynvml.nvmlDeviceGetUtilizationRates(h)
        try: temp = pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU)
        except Exception: temp = 0
        try: pw = pynvml.nvmlDeviceGetPowerUsage(h) / 1000.0
        except Exception: pw = 0
        nm = pynvml.nvmlDeviceGetName(h); nm = nm.decode() if isinstance(nm, bytes) else nm
        out.append({"index": i, "host": "gpu", "name": nm, "util": u.gpu, "mem_used": m.used // (1024 * 1024),
                    "mem_total": m.total // (1024 * 1024), "temp": temp, "power": round(pw, 1)})
    out.extend(remote_gpu_stats())
    return out


def _avg_load():
    s = gpu_stats(); return (sum(g["util"] for g in s) / len(s) / 100.0) if s else 0.0


DATA = {"guests": [], "storage": [], "nodes": [], "pools": [], "unifi": {}, "zabbix": {}, "cameras": [],
        "sources": {}, "health": [], "netmap": {}, "fleet": {}, "addons": {}, "ts": 0}
pollers.bind(DATA)     # lets the inventory resolve names against the live topology


# =========================================================================
# Core pollers
# =========================================================================
def poll_pve():
    while True:
        guests = []; storage = []; nodes = []; pools = []
        ok = False          # did ANY call this tick actually return data?
        for n in pollers.pve_nodes():
            H = {"Authorization": f"PVEAPIToken={n['token']}"}
            try:
                r = requests.get(f"{n['url']}/api2/json/cluster/resources?type=vm", headers=H, verify=False, timeout=5)
                if r.status_code != 200: raise RuntimeError(f"HTTP {r.status_code}")
                data = r.json().get("data")
                if data is None: raise RuntimeError("no data field")
                ok = True
                for g in data:
                    guests.append({"id": g.get("vmid"), "name": g.get("name", str(g.get("vmid"))), "type": g.get("type"),
                        "status": g.get("status"), "node": g.get("node", n["node"]), "cpu": round(g.get("cpu", 0) * 100, 1),
                        "mem": g.get("mem", 0), "maxmem": g.get("maxmem", 1), "cat": categorize(g.get("name"))})
            except Exception as e: print("[pve]", n["node"], e, flush=True)
            try:
                r = requests.get(f"{n['url']}/api2/json/nodes/{n['node']}/storage", headers=H, verify=False, timeout=5)
                for s in r.json().get("data", []):
                    if s.get("total"): storage.append({"node": n["node"], "name": s["storage"], "type": s.get("type"),
                        "used": s.get("used", 0), "total": s.get("total", 1), "pct": round(s.get("used", 0) / max(s.get("total", 1), 1) * 100, 1)})
            except Exception as e: print("[pve-stor]", n["node"], e, flush=True)
            try:   # physical hypervisor vitals (cpu/mem/load/uptime)
                st = requests.get(f"{n['url']}/api2/json/nodes/{n['node']}/status", headers=H, verify=False, timeout=5).json().get("data", {})
                mem = st.get("memory", {}) or {}; la = st.get("loadavg", [0, 0, 0]) or [0, 0, 0]
                nodes.append({"node": n["node"], "cpu": round(st.get("cpu", 0) * 100, 1),
                    "cores": (st.get("cpuinfo", {}) or {}).get("cpus", 0), "mem_used": mem.get("used", 0),
                    "mem_total": mem.get("total", 1), "load": float(la[0]), "uptime": st.get("uptime", 0)})
            except Exception as e: print("[pve-node]", n["node"], e, flush=True)
            try:   # ZFS pool HEALTH + fragmentation (so a DEGRADED array / failing disk shows, not just %used)
                for p in requests.get(f"{n['url']}/api2/json/nodes/{n['node']}/disks/zfs", headers=H, verify=False, timeout=5).json().get("data", []):
                    pools.append({"node": n["node"], "name": p.get("name"), "health": p.get("health", "?"),
                        "frag": p.get("frag", 0), "alloc": p.get("alloc", 0), "free": p.get("free", 0), "size": p.get("size", 1)})
            except Exception as e: print("[pve-zfs]", n["node"], e, flush=True)
        # dedupe guests a cluster reports from every node
        seen = set(); uniq = []
        for g in guests:
            k = (g["node"], g["id"])
            if k in seen: continue
            seen.add(k); uniq.append(g)
        if uniq: DATA["guests"] = sorted(uniq, key=lambda x: (x["node"], x["cat"], x["id"]))
        if storage: DATA["storage"] = storage
        if nodes: DATA["nodes"] = nodes; DATA["pools"] = pools
        # ts moves only on a real answer, so a dead token or an unreachable host
        # reads as stale instead of "fresh"; the age of the data is visible.
        if ok:
            DATA["ts"] = time.time()
            DATA["ts_err"] = None
        elif DATA.get("ts"):
            DATA["ts_err"] = "no proxmox endpoint answered"
        time.sleep(6)


_unifi_s = None


def poll_unifi():
    global _unifi_s
    if not UNIFI:
        return
    while True:
        try:
            if _unifi_s is None:
                _unifi_s = requests.Session()
                _unifi_s.post(f"{UNIFI}/api/auth/login", json={"username": UNIFI_USER, "password": UNIFI_PASS}, verify=False, timeout=6)
            base = f"{UNIFI}/proxy/network/api/s/{UNIFI_SITE}"
            cl = _unifi_s.get(f"{base}/stat/sta", verify=False, timeout=6).json().get("data", [])
            if not cl:           # session expired (the controller returns empty, no exception) -> re-login next cycle, keep last-good
                _unifi_s = None; time.sleep(8); continue
            dv = _unifi_s.get(f"{base}/stat/device", verify=False, timeout=6).json().get("data", [])
            hp = _unifi_s.get(f"{base}/stat/health", verify=False, timeout=6).json().get("data", [])
            wan = next((h for h in hp if h.get("subsystem") == "wan"), {})
            # newer firmware reports the WAN subsystem as "status", not "uplink_status"
            us = wan.get("uptime_stats", {}).get("WAN", {}) if isinstance(wan.get("uptime_stats"), dict) else {}
            DATA["unifi"] = {"clients": len(cl), "wifi": sum(1 for c in cl if not c.get("is_wired")),
                "devices": len(dv), "wan_up": wan.get("status") or wan.get("uplink_status", "?"),
                "rx": round(wan.get("rx_bytes-r", 0) * 8 / 1e6, 1), "tx": round(wan.get("tx_bytes-r", 0) * 8 / 1e6, 1),
                "isp": wan.get("isp_name", "") or config.WAN_LABEL, "wan_ip": wan.get("wan_ip", ""),
                "latency": round(us.get("latency_average", 0) or wan.get("latency", 0) or 0)}
        except Exception as e:
            _unifi_s = None; DATA["unifi"] = DATA.get("unifi") or {"error": str(e)[:60]}
        time.sleep(8)


def poll_zbx():
    if not ZBX_URL:
        return
    while True:
        try:
            tok = requests.post(ZBX_URL, json={"jsonrpc": "2.0", "method": "user.login",
                "params": {"username": ZBX_USER, "password": ZBX_PASS}, "id": 1}, timeout=8).json().get("result")
            if tok:
                H = {"Authorization": f"Bearer {tok}"}
                hosts = requests.post(ZBX_URL, headers=H, json={"jsonrpc": "2.0", "method": "host.get", "params": {"countOutput": True}, "id": 2}, timeout=8).json().get("result")
                probs = requests.post(ZBX_URL, headers=H, json={"jsonrpc": "2.0", "method": "problem.get", "params": {"output": ["eventid", "name", "severity", "objectid", "acknowledged"], "severities": [2, 3, 4, 5], "suppressed": False}, "id": 3}, timeout=8).json().get("result", [])
                # map triggers -> host names, build per-host alert feed for planet flares
                trigids = list({p.get("objectid") for p in probs if p.get("objectid")})
                tmap = {}
                if trigids:
                    # "monitored":True mirrors what the Zabbix UI shows - it drops problems whose
                    # host or item is disabled, which otherwise inflate the alert count forever.
                    trg = requests.post(ZBX_URL, headers=H, json={"jsonrpc": "2.0", "method": "trigger.get", "params": {"triggerids": trigids, "monitored": True, "selectHosts": ["host"], "output": ["triggerid"]}, "id": 4}, timeout=8).json().get("result", [])
                    for t in trg: tmap[t["triggerid"]] = (t["hosts"][0]["host"] if t.get("hosts") else None)
                probs = [p for p in probs if tmap.get(p.get("objectid"))]
                sev = {}
                for p in probs: sev[int(p.get("severity", 0))] = sev.get(int(p.get("severity", 0)), 0) + 1
                alert_hosts = {}
                for p in probs:
                    hn = tmap.get(p.get("objectid"))
                    if not hn: continue
                    a = alert_hosts.setdefault(hn, {"sev": 0, "n": 0, "unack": 0, "names": []})
                    a["sev"] = max(a["sev"], int(p.get("severity", 0))); a["n"] += 1
                    if str(p.get("acknowledged")) != "1": a["unack"] += 1
                    if len(a["names"]) < 3: a["names"].append(p.get("name", "")[:60])
                DATA["zabbix"] = {"hosts": int(hosts or 0), "problems": len(probs), "sev": sev, "alert_hosts": alert_hosts}
            else:
                DATA["zabbix"] = {"error": "auth"}
        except Exception as e:
            DATA["zabbix"] = {"error": str(e)[:60]}
        time.sleep(15)


def poll_cams():
    if not FRIGATE:
        return
    while True:
        try:
            cfg = requests.get(f"{FRIGATE}/api/config", timeout=6).json()
            DATA["cameras"] = list(cfg.get("cameras", {}).keys())
        except Exception: pass
        time.sleep(30)


def poll_sources():
    if not (ZBX_URL or GRAFANA or PROM):
        return
    while True:
        s = {}
        if ZBX_URL:
            try:
                tok = requests.post(ZBX_URL, json={"jsonrpc": "2.0", "method": "user.login", "params": {"username": ZBX_USER, "password": ZBX_PASS}, "id": 1}, timeout=8).json().get("result")
                if tok:
                    H = {"Authorization": f"Bearer {tok}"}
                    it = requests.post(ZBX_URL, headers=H, json={"jsonrpc": "2.0", "method": "item.get", "params": {"countOutput": True, "monitored": True}, "id": 2}, timeout=10).json().get("result")
                    tr = requests.post(ZBX_URL, headers=H, json={"jsonrpc": "2.0", "method": "trigger.get", "params": {"countOutput": True}, "id": 3}, timeout=10).json().get("result")
                    s["zabbix"] = {"up": True, "items": int(it or 0), "triggers": int(tr or 0), "hosts": (DATA.get("zabbix") or {}).get("hosts"), "problems": (DATA.get("zabbix") or {}).get("problems")}
                else: s["zabbix"] = {"up": False}
            except Exception: s["zabbix"] = {"up": False}
        if GRAFANA:
            try:
                ds = requests.get(f"{GRAFANA}/api/datasources", headers=GRAFANA_HEADERS, timeout=6).json()
                db = requests.get(f"{GRAFANA}/api/search?type=dash-db", headers=GRAFANA_HEADERS, timeout=6).json()
                s["grafana"] = {"up": True, "datasources": len(ds), "dashboards": len(db), "ds": [d.get("type") for d in ds]}
            except Exception: s["grafana"] = {"up": False}
        if PROM:
            try:
                up = requests.get(f"{PROM}/api/v1/query?query=up", timeout=6).json()["data"]["result"]
                s["prometheus"] = {"up": True, "targets": len(up), "healthy": sum(1 for x in up if x["value"][1] == "1")}
            except Exception: s["prometheus"] = {"up": False}
        DATA["sources"] = s
        time.sleep(30)


# Service health pips. Configured via SVC_<n>_* (see .env.example); the address is
# resolved live from the guest inventory when SVC_<n>_GUEST is set, so a container
# that moves is followed instead of being checked at its old address forever.
# Each result carries `src`: "inventory" (resolved live) or "pinned" (the URL as configured).
def poll_health():
    while True:
        out = []
        for t in pollers.health_targets():
            name, cat, url = t["name"], t["cat"], t["url"]
            t0 = time.time()
            try:
                r = requests.get(url, timeout=5, verify=False)
                out.append({"name": name, "cat": cat, "up": r.status_code < 500, "ms": int((time.time() - t0) * 1000), "code": r.status_code, "ip": t["ip"], "src": t["src"]})
            except Exception:
                out.append({"name": name, "cat": cat, "up": False, "ms": int((time.time() - t0) * 1000), "code": 0, "ip": t["ip"], "src": t["src"]})
        DATA["health"] = out
        time.sleep(20)


def poll_netmap():
    """Poll an external topology JSON (e.g. exported from LibreNMS). Optional."""
    if not NETMAP_URL:
        return
    while True:
        try:
            r = requests.get(NETMAP_URL, timeout=5)
            DATA["netmap"] = r.json()
        except Exception as e:
            print("[netmap]", e, flush=True)
        time.sleep(15)


def poll_fleet():
    """Reachability for an arbitrary list of host:port services, plus an optional
    JSON stats endpoint. Configured via FLEET_<n>_* / FLEET_STATS_URL."""
    targets = config.FLEET_TARGETS
    stats_url = config.FLEET_STATS_URL
    if not targets and not stats_url:
        return
    while True:
        d = {"services": [], "stats": {}}
        if stats_url:
            try:
                d["stats"] = requests.get(stats_url, timeout=4).json()
                d["stats"]["up"] = True
            except Exception:
                d["stats"] = {"up": False}
        for t in targets:
            up = False
            try:
                so = socket.create_connection((t["host"], int(t["port"])), timeout=2)
                so.close()
                up = True
            except Exception:
                up = False
            d["services"].append({"name": t["name"], "up": up})
        DATA["fleet"] = d
        time.sleep(10)


# =========================================================================
# History: SQLite sampler + per-host RTT baseline
# =========================================================================
DBPATH = config.METRICS_DB


def _db():
    c = sqlite3.connect(DBPATH, timeout=10); c.execute("PRAGMA journal_mode=WAL"); return c


def sampler():
    c = _db()
    c.execute("CREATE TABLE IF NOT EXISTS gpu(ts INT, idx INT, util INT, mem INT, temp INT, power REAL)")
    c.execute("CREATE TABLE IF NOT EXISTS guest(ts INT, id INT, cpu REAL, mem INT)")
    c.execute("CREATE TABLE IF NOT EXISTS net(ts INT, clients INT, rx REAL, tx REAL, problems INT)")
    # probe.py measures real RTT/jitter/loss per host; keyed on IP because that is
    # the only identity the prober has, and it survives a node being renamed.
    c.execute("CREATE TABLE IF NOT EXISTS rtt(ts INT, ip TEXT, rtt REAL, jitter REAL, loss INT)")
    c.execute("CREATE INDEX IF NOT EXISTS i_gpu ON gpu(idx,ts)")
    c.execute("CREATE INDEX IF NOT EXISTS i_guest ON guest(id,ts)")
    c.execute("CREATE INDEX IF NOT EXISTS i_rtt ON rtt(ip,ts)")
    c.commit(); c.close()
    while True:
        try:
            now = int(time.time()); c = _db()
            for g in gpu_stats():
                c.execute("INSERT INTO gpu VALUES(?,?,?,?,?,?)", (now, g["index"], g["util"], g["mem_used"], g["temp"], g["power"]))
            for g in DATA.get("guests", []):
                if g.get("status") == "running":
                    c.execute("INSERT INTO guest VALUES(?,?,?,?)", (now, g["id"], g.get("cpu", 0), g.get("mem", 0)))
            u = DATA.get("unifi", {}) or {}; z = DATA.get("zabbix", {}) or {}
            c.execute("INSERT INTO net VALUES(?,?,?,?,?)", (now, u.get("clients", 0), u.get("rx", 0), u.get("tx", 0), z.get("problems", 0)))
            # a host that did not answer is stored with rtt NULL and loss 100 - never as latency 0
            for ip, r in ((DATA.get("probe") or {}).get("rtt") or {}).items():
                c.execute("INSERT INTO rtt VALUES(?,?,?,?,?)", (now, str(ip), r.get("rtt"), r.get("jitter"), r.get("loss")))
            cut = now - (config.HISTORY_DAYS * 86400)
            for t in ("gpu", "guest", "net", "rtt"): c.execute(f"DELETE FROM {t} WHERE ts<?", (cut,))
            c.commit(); c.close()
        except Exception as e:
            print("[sampler]", e, flush=True)
        time.sleep(30)


# "Is this link slow?" has no absolute answer: 0.3 ms is normal for a wired
# guest, 25 ms for a phone on wifi, 40 ms for a remote site. Severity is
# measured against each host's OWN median over the sampled window instead.
# An IP with too few samples is ABSENT from the reply, not present with a
# made-up baseline.
_BASE_WIN = 6 * 3600     # window the median is taken over
_BASE_MIN_N = 20         # fewer samples than this is not a baseline
_BASE_TTL = 120          # this is a table scan; recompute at most this often
_base_cache = {"ts": 0.0, "val": None}
_base_lock = threading.Lock()


def _rtt_baseline():
    now = time.time()
    with _base_lock:
        if _base_cache["val"] is not None and now - _base_cache["ts"] < _BASE_TTL:
            return _base_cache["val"]
    cut = int(now) - _BASE_WIN
    by_ip = {}
    misses = {}
    c = _db()
    try:
        for ip, rtt in c.execute("SELECT ip,rtt FROM rtt WHERE ts>?", (cut,)):
            if rtt is None:
                misses[ip] = misses.get(ip, 0) + 1
            else:
                by_ip.setdefault(ip, []).append(rtt)
    except sqlite3.OperationalError:
        pass                              # table not created yet (sampler not started)
    finally:
        c.close()
    ips = {}
    for ip, vals in by_ip.items():
        n = len(vals)
        if n < _BASE_MIN_N:
            continue
        vals.sort()
        tot = n + misses.get(ip, 0)
        ips[ip] = {
            "p50": round(vals[n // 2], 3),
            "p95": round(vals[min(n - 1, int(n * 0.95))], 3),
            "n": n,
            # share of samples in the window where the host did not answer at all
            "miss": round(misses.get(ip, 0) * 100.0 / tot, 1) if tot else 0.0,
        }
    out = {"win": _BASE_WIN, "min_n": _BASE_MIN_N, "ips": ips}
    with _base_lock:
        _base_cache["ts"] = now
        _base_cache["val"] = out
    return out


# =========================================================================
# Routes served in every mode
# =========================================================================
def _render(name):
    try:
        return render_template(name)
    except TemplateNotFound:
        return Response(f"templates/{name} is missing from this checkout", status=404, mimetype="text/plain")


@app.route("/")
def index():
    if not config.DEMO and not config.is_configured() and config.SETUP_UI:
        return redirect("/setup")
    return _render("index.html")


@app.route("/desk")
def desk():
    return _render("desk.html")


@app.route("/nexus")
def nexus():
    return _render("nexus.html")


def _node_names():
    names = [n.get("node") for n in (DATA.get("nodes") or []) if n.get("node")]
    if not config.DEMO and config.PVE_NODES:
        try:
            names += [n["node"] for n in pollers.pve_nodes()]
        except Exception:
            pass
    return names


@app.route("/api/config")
def api_config():
    """What the screens need before they draw anything (docs/contracts.md). Never a credential."""
    demo = config.DEMO
    doom = bool(config.ENABLE_DOOM and os.path.exists(os.path.join(HERE, "static", "doom", "js-dos.js")))
    features = {
        "nexus": bool(config.ENABLE_NEXUS),
        "cameras": bool(config.ENABLE_CAMERAS and (FRIGATE or (demo and DATA.get("cameras")))),
        "threats": bool(config.ENABLE_THREATS and (demo or config.CROWDSEC_EXPORT_URL or config.SECMON_URL)),
        "audience": bool(demo or config.AUDIENCE_URL or (config.CF_API_TOKEN and config.CF_ZONE_ID)),
        "lights": bool(config.ENABLE_LIGHTS),
        "doom": doom,
        "setup": bool(config.SETUP_UI and not demo),
        "chat": bool(demo or OLLAMA),
    }
    return jsonify({
        "version": config.VERSION, "demo": demo,
        "brand": config.BRAND, "domain": config.DOMAIN or ("example.com" if demo else ""),
        "tagline": config.TAGLINE, "nodes": config.node_entries(_node_names()),
        "wan_label": config.WAN_LABEL, "categories": config.CATEGORY_LIST, "palette": config.PALETTE,
        "features": features, "addons": sorted(DATA.get("addons") or {}),
    })


@app.route("/api/topology")
def api_topology():
    return jsonify(DATA.get("topology") or {})


@app.route("/api/all")
def api_all():
    g = DATA["guests"]
    return jsonify({"guests": g, "storage": DATA["storage"], "nodes": DATA["nodes"], "pools": DATA["pools"],
        "unifi": DATA["unifi"], "zabbix": DATA["zabbix"], "cameras": DATA["cameras"], "sources": DATA["sources"],
        "health": DATA["health"], "netmap": DATA["netmap"], "fleet": DATA.get("fleet") or {},
        "ai_servers": DATA.get("ai_servers") or [], "addons": DATA.get("addons") or {},
        "total": len(g), "running": sum(1 for x in g if x.get("status") == "running"), "ts": DATA["ts"],
        "ts_age": round(time.time() - DATA["ts"], 1) if DATA.get("ts") else None, "ts_err": DATA.get("ts_err"),
        **{k: DATA.get(k) for k in ("nodes2", "zfs", "backups", "frigate", "top", "certs", "zbx2", "latency",
                                    "topology", "probe", "telemetry", "edge", "external") if DATA.get(k) is not None}})


# ---- room light sync ------------------------------------------------------
# lightsync.js (running in the browser on the wall) POSTs the galaxy's current
# dominant colour here; the lights driver (deploy/lights/) GETs it and drives
# the bulbs. Single slot, last write wins, no persistence wanted.
# `rgb`/`hue` are the sampled on-screen colour; the rest is the dashboard telling
# the lights what it is DOING, so they can be timed to the camera:
#   mode   tour | doom | alert | threat - which behaviour the driver should run
#   phase  hold | travel                - the tour is parked, or flying between stops
#   beat   monotonic counter            - +1 each time the tour ARRIVES at a stop
#   bri    0-100                        - target brightness the scene is asking for
#   stop / stop_name                    - which stop the wall is parked on (the TV follows)
# Sync protocol v2 (contract with the /nexus side) adds from/to/to_name, idx/n,
# prog (0..1 travel ratio), travel_s/hold_s, manual and stops[] so the second
# screen can pre-plan instead of reacting stop-by-stop.
def _ls_clamp01(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 1.0
    if f != f or f in (float("inf"), float("-inf")):   # NaN / Inf guard
        return 1.0
    return max(0.0, min(1.0, f))


def _ls_finite_nonneg(v, hi):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    if f != f or f in (float("inf"), float("-inf")):
        return 0.0
    return max(0.0, min(hi, f))


def _ls_clamp_stops(v):
    out = []
    if isinstance(v, list):
        for item in v[:64]:
            if not isinstance(item, dict):
                continue
            out.append({"key": str(item.get("key", ""))[:64], "name": str(item.get("name", ""))[:96]})
    return out


LIGHTSTATE = {"rgb": [0, 128, 255], "hue": 210, "lit": 0,
              "mode": "tour", "phase": "hold", "beat": 0, "bri": 100,
              "stop": "", "stop_name": "",
              "from": "", "to": "", "to_name": "",
              "idx": 0, "n": 0, "prog": 1.0,
              "travel_s": 0.0, "hold_s": 0.0,
              "manual": False, "stops": [],
              "ts": 0}

# version counter + Condition so /api/lightstate/stream can block instead of
# polling: a change wakes every open connection immediately.
_ls_lock = threading.Lock()
_ls_cond = threading.Condition(_ls_lock)
_ls_version = 0


def _ls_changed(old, new):
    return any(old.get(k) != new.get(k) for k in new if k != "ts")


@app.route("/api/lightstate", methods=["GET", "POST"])
def api_lightstate():
    global LIGHTSTATE, _ls_version
    if request.method == "POST":
        d = request.get_json(silent=True) or {}
        rgb = d.get("rgb")
        if isinstance(rgb, list) and len(rgb) == 3:
            try:
                mode = str(d.get("mode", "tour")).lower()
                if mode not in ("tour", "doom", "alert", "threat"):   # threat: the room flashes red on a new intrusion
                    mode = "tour"
                phase = "travel" if str(d.get("phase", "")).lower() == "travel" else "hold"
                new_state = {
                    "rgb": [max(0, min(255, int(c))) for c in rgb],
                    "hue": int(d.get("hue", 0)),
                    "lit": int(d.get("lit", 0)),
                    "mode": mode,
                    "phase": phase,
                    "beat": max(0, int(d.get("beat", 0))),
                    "bri": max(0, min(100, int(d.get("bri", 100)))),
                    "stop": str(d.get("stop", ""))[:64],
                    "stop_name": str(d.get("stop_name", ""))[:96],
                    "from": str(d.get("from", ""))[:64],
                    "to": str(d.get("to", ""))[:64],
                    "to_name": str(d.get("to_name", ""))[:96],
                    "idx": max(0, min(10000, int(d.get("idx", 0)))),
                    "n": max(0, min(10000, int(d.get("n", 0)))),
                    "prog": _ls_clamp01(d.get("prog", 1.0)),
                    "travel_s": _ls_finite_nonneg(d.get("travel_s", 0.0), 120.0),
                    "hold_s": _ls_finite_nonneg(d.get("hold_s", 0.0), 120.0),
                    "manual": bool(d.get("manual", False)),
                    "stops": _ls_clamp_stops(d.get("stops")),
                    "ts": time.time(),
                }
            except (TypeError, ValueError):
                return jsonify({"ok": False, "err": "bad rgb"}), 400
            with _ls_cond:
                if _ls_changed(LIGHTSTATE, new_state):
                    _ls_version += 1
                    LIGHTSTATE = new_state
                    _ls_cond.notify_all()
                else:
                    LIGHTSTATE = new_state   # still refresh ts
            return jsonify({"ok": True})
        return jsonify({"ok": False, "err": "bad rgb"}), 400
    body = dict(LIGHTSTATE)
    body["stale"] = (time.time() - (body.get("ts") or 0)) > config.LIGHTS_STALE_S
    body["enabled"] = LIGHTENABLE["enabled"]
    return jsonify(body)


# Per-screen sampled colour. Deliberately separate from LIGHTSTATE: that carries the
# tour protocol and the second screen consumes it via SSE, so it must never write to it.
LIGHTCOLORS = {}
_lc_lock = threading.Lock()

# Room lighting INTENT, set by a home automation. The lights driver must not
# write colour/brightness while this is false: those commands wake an off bulb.
LIGHTENABLE = {"enabled": True, "ts": 0.0}


@app.route("/api/lightenable", methods=["GET", "POST"])
def api_lightenable():
    global LIGHTENABLE
    if request.method == "POST":
        d = request.get_json(silent=True) or {}
        LIGHTENABLE = {"enabled": bool(d.get("enabled", True)), "ts": time.time()}
        return jsonify({"ok": True, "enabled": LIGHTENABLE["enabled"]})
    return jsonify(LIGHTENABLE)


@app.route("/api/lightcolor", methods=["GET", "POST"])
def api_lightcolor():
    if request.method == "POST":
        d = request.get_json(silent=True) or {}
        srcname = str(d.get("src", "wall")).lower()
        if srcname not in ("wall", "nexus"):
            srcname = "wall"
        rgb = d.get("rgb")
        if not (isinstance(rgb, list) and len(rgb) == 3):
            return jsonify({"ok": False, "err": "bad rgb"}), 400
        try:
            entry = {
                "rgb": [max(0, min(255, int(c))) for c in rgb],
                "bri": max(0, min(100, int(d.get("bri", 100)))),
                "ts": time.time(),
            }
        except (TypeError, ValueError):
            return jsonify({"ok": False, "err": "bad rgb"}), 400
        with _lc_lock:
            LIGHTCOLORS[srcname] = entry
        return jsonify({"ok": True})
    with _lc_lock:
        return jsonify(dict(LIGHTCOLORS))


def _sse(gen):
    return Response(gen(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


@app.route("/api/lightstate/stream")
def api_lightstate_stream():
    """SSE companion to /api/lightstate: one `data:` frame per POST that
    changes anything besides ts, plus a keepalive comment every 15 s. Blocks on
    a Condition rather than polling, so a phase/beat flip on the wall reaches
    the second screen in well under a frame."""
    def gen():
        yield "retry: 3000\n\n"
        last = None
        while True:
            with _ls_cond:
                _ls_cond.wait_for(lambda: _ls_version != last, timeout=15)  # noqa: B023 - called at once
                cur = _ls_version
                state = LIGHTSTATE
            if cur != last:
                last = cur
                yield "data: " + json.dumps(state) + "\n\n"
            else:
                yield ": keepalive\n\n"
    return _sse(gen)


# ---- DOOM takeover ---------------------------------------------------------
# A one-slot trigger the dashboard polls. Written by the kiosk key combo (which
# posts here so every open dashboard follows the same state) or by any
# automation. `id` increments on every write so a client fires each trigger
# exactly once instead of re-firing on every poll.
# `secs` is a hard ceiling and `idle` a no-input timeout, both clamped here as
# well as in the browser: this drives a 24/7 wall display and it must not be
# possible to leave it parked on DOOM by sending one bad number.
# `delay` arms the takeover instead of firing it: the dashboard counts down
# visibly, then glitches.
TAKEOVER = {"mode": "off", "id": 0, "secs": 120, "idle": 15, "delay": 10, "ts": 0}


@app.route("/api/takeover", methods=["GET", "POST"])
def api_takeover():
    global TAKEOVER
    if request.method == "POST":
        d = request.get_json(silent=True) or request.form.to_dict() or {}
        mode = str(d.get("mode", "doom")).lower()
        if mode not in ("doom", "off"):
            return jsonify({"ok": False, "err": "mode must be doom or off"}), 400

        def _clamp(key, default, lo, hi):
            try:
                return max(lo, min(hi, int(d.get(key, default))))
            except (TypeError, ValueError):
                return default

        TAKEOVER = {
            "mode": mode,
            "id": TAKEOVER["id"] + 1,
            "secs": _clamp("secs", 120, 10, 900),
            "idle": _clamp("idle", 15, 5, 300),
            "delay": _clamp("delay", 10, 0, 120),
            "ts": time.time(),
        }
        return jsonify(dict(TAKEOVER, ok=True))
    return jsonify(TAKEOVER)


@app.route("/api/takeover/stream")
def api_takeover_stream():
    """Server-sent events, so a trigger lands on the wall the instant it is
    written instead of on the next poll. The client keeps its poll as a
    fallback, so if this stream is unavailable the takeover still works, later."""
    def gen():
        yield "retry: 3000\n\n"
        last = None
        while True:
            cur = TAKEOVER.get("id")
            if cur != last:
                last = cur
                yield "data: " + json.dumps(TAKEOVER) + "\n\n"
            else:
                yield ": ka\n\n"      # also how a dead client gets noticed: the write fails
            time.sleep(0.25)
    return _sse(gen)


@app.route("/api/pulse/stream")
def api_pulse_stream():
    """Shared heartbeat for the wall and the second screen, so two physical
    displays in the same room visibly breathe in sync. The beat number is
    derived from wall-clock time (not a per-connection counter), so any client
    that connects lands on the same beat as every other. Severity is real: it
    comes straight off the same zabbix/netmap state the panels already show."""
    PERIOD = 4.0

    def gen():
        yield "retry: 3000\n\n"
        last_beat = None
        while True:
            beat = int(time.time() // PERIOD)
            if beat != last_beat:
                last_beat = beat
                z = DATA.get("zabbix") or {}
                nm = DATA.get("netmap") or {}
                problems = int(z.get("problems") or 0)
                net_total = int(nm.get("total") or 0)
                net_up = int(nm.get("up") or 0)
                net_down = max(0, net_total - net_up)
                sev = 0
                if net_down: sev = 2
                if problems: sev = 3
                yield "data: " + json.dumps({"beat": beat, "ts": time.time(), "sev": sev,
                                             "problems": problems, "net_down": net_down}) + "\n\n"
            else:
                yield ": ka\n\n"
            time.sleep(0.5)
    return _sse(gen)


# =========================================================================
# Routes that demo.py provides from fixtures instead (registered only live)
# =========================================================================
def _install_live_routes():
    @app.route("/api/gpu")
    def api_gpu():
        render_backend = "disabled"
        if gpu_render is not None:
            render_backend = getattr(getattr(gpu_render, "_renderer", None), "renderer", "init")
        return jsonify({"gpus": gpu_stats(), "render_backend": render_backend})

    @app.route("/api/history")
    def api_history():
        mins = int(request.args.get("mins", 120)); cut = int(time.time()) - mins * 60
        c = _db(); out = []
        try:
            if request.args.get("guest"):
                gid = int(request.args["guest"])
                out = [{"ts": r[0], "cpu": r[1], "mem": r[2]} for r in
                       c.execute("SELECT ts,cpu,mem FROM guest WHERE id=? AND ts>? ORDER BY ts", (gid, cut)).fetchall()]
            elif request.args.get("metric") == "gpu":
                idx = int(request.args.get("idx", 0))
                out = [{"ts": r[0], "util": r[1], "mem": r[2], "temp": r[3], "power": r[4]} for r in
                       c.execute("SELECT ts,util,mem,temp,power FROM gpu WHERE idx=? AND ts>? ORDER BY ts", (idx, cut)).fetchall()]
            elif request.args.get("metric") == "rtt":
                ip = str(request.args.get("ip", ""))
                out = [{"ts": r[0], "rtt": r[1], "jitter": r[2], "loss": r[3]} for r in
                       c.execute("SELECT ts,rtt,jitter,loss FROM rtt WHERE ip=? AND ts>? ORDER BY ts", (ip, cut)).fetchall()]
            elif request.args.get("metric") == "net":
                out = [{"ts": r[0], "clients": r[1], "rx": r[2], "tx": r[3], "problems": r[4]} for r in
                       c.execute("SELECT ts,clients,rx,tx,problems FROM net WHERE ts>? ORDER BY ts", (cut,)).fetchall()]
        except sqlite3.OperationalError:
            out = []                      # tables appear once the sampler has run
        finally:
            c.close()
        return jsonify(out)

    @app.route("/api/inventory")
    def api_inventory():
        """What the dashboard currently believes exists, and where each fact came from."""
        return jsonify(pollers.inventory_summary())

    @app.route("/api/rtt/baseline")
    def api_rtt_baseline():
        return jsonify(_rtt_baseline())

    @app.route("/api/telemetry")
    def api_telemetry():
        return jsonify(DATA.get("telemetry") or {})

    @app.route("/api/prom")
    def api_prom():
        """Read-only PromQL passthrough so pages can ask for one series without a new poller."""
        q = request.args.get("query", "")
        if not q or len(q) > 2000: return jsonify({"error": "query required"}), 400
        if not PROM: return jsonify({"error": "PROM_URL not configured"}), 404
        try:
            r = requests.get(f"{PROM}/api/v1/query", params={"query": q}, timeout=8)
            return Response(r.content, status=r.status_code, mimetype="application/json")
        except Exception as e: return jsonify({"error": str(e)}), 502

    @app.route("/cam/<name>.jpg")
    def cam(name):
        if not FRIGATE:
            return Response(status=404)
        try:
            r = requests.get(f"{FRIGATE}/api/{name}/latest.jpg?h=360", timeout=6)
            return Response(r.content, mimetype="image/jpeg")
        except Exception:
            return Response(b"", mimetype="image/jpeg")

    @app.route("/api/chat", methods=["POST"])
    def api_chat():
        msg = (request.json or {}).get("message", "")
        if not OLLAMA:
            return jsonify({"reply": "(chat disabled: OLLAMA_URL is not configured)"})
        try:
            r = requests.post(f"{OLLAMA}/api/generate", json={"model": OLLAMA_MODEL, "prompt": msg, "stream": False}, timeout=120)
            return jsonify({"reply": r.json().get("response", "").strip()})
        except Exception as e:
            return jsonify({"reply": f"(ollama unavailable: {e})"})


# =========================================================================
# Wiring
# =========================================================================
_presence_active = lambda: True   # noqa: E731 - replaced by showtime.is_presence_active when installed
DEMO_FEED = None

if config.DEMO:
    import demo
    DEMO_FEED = demo.install(app, DATA)
    try:   # the lights slot starts from the fixture instead of the neutral default
        with open(os.path.join(demo.FIXTURES, "lightstate.json")) as fh:
            LIGHTSTATE = dict(LIGHTSTATE, **json.load(fh)); LIGHTSTATE["ts"] = time.time()
    except Exception:
        pass
else:
    _install_live_routes()
    import showtime
    import threats
    threats.install(app)
    showtime.install(app, DATA)
    _presence_active = showtime.is_presence_active
    if config.SETUP_UI:
        import setup
        setup.install(app)


def start_background_pollers():
    for fn in (poll_pve, poll_unifi, poll_zbx, poll_cams, poll_sources, poll_health, poll_netmap, poll_fleet, sampler):
        threading.Thread(target=fn, daemon=True, name=fn.__name__).start()
    steps = [("pollers", lambda: pollers.start_new_pollers(DATA)),
             ("topology", lambda: __import__("topology").start_topology_poller(DATA)),
             ("edge", lambda: __import__("edge").start_edge(DATA)),
             ("threats", lambda: __import__("threats").start(DATA)),
             ("showtime", lambda: __import__("showtime").start(DATA)),
             ("addons", lambda: __import__("addons").load(app, DATA, config))]
    if config.ENABLE_PROBE:
        steps.insert(2, ("probe", lambda: __import__("probe").start_probe(DATA)))
    for name, fn in steps:
        try:
            fn()
            print(f"[{name}] started", flush=True)
        except Exception as e:
            print(f"[{name}] not started: {e}", flush=True)
    if gpu_render is not None:
        try:
            gpu_render.start(_avg_load, _presence_active)
        except Exception as e:
            print("[gpu_render] not started:", e, flush=True)


if __name__ == "__main__":
    if config.DEMO:
        print("[demo] DEMO=1: serving demo/fixtures, no pollers, no network", flush=True)
        if config.DEMO_ADDONS:
            try:
                __import__("addons").load(app, DATA, config)
            except Exception as e:
                print("[addons] not started:", e, flush=True)
    elif not config.is_configured():
        if not config.SETUP_UI:
            print("Configuration incomplete — the dashboard cannot start:\n", flush=True)
            for p in config.missing_required():
                print("  *", p, flush=True)
            print("\nCopy .env.example to .env, fill it in, and re-run (or set SETUP_UI=true).", flush=True)
            raise SystemExit(1)
        host = "localhost" if config.LISTEN_HOST in ("0.0.0.0", "") else config.LISTEN_HOST
        print(f"Nothing configured yet: open http://{host}:{config.LISTEN_PORT}/setup and paste the token printed above.", flush=True)
    else:
        problems = config.missing_required()
        if problems:
            print("Configuration incomplete — the dashboard cannot start:\n", flush=True)
            for p in problems:
                print("  *", p, flush=True)
            print("\nFix the variables above (or use /setup) and re-run.", flush=True)
            raise SystemExit(1)
        start_background_pollers()
    app.run(host=config.LISTEN_HOST, port=config.LISTEN_PORT, threaded=True)
