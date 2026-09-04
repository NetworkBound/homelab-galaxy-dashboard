#!/usr/bin/env python3
"""Homelab Galaxy — a cinematic, GPU-accelerated 3D monitoring console.

Every guest in your Proxmox cluster becomes a lit planet, each node a spiral
galaxy, storage pools ringed worlds, and cameras orbiting satellites. All of it
is driven by live data polled in the background from Proxmox, Zabbix, UniFi,
Frigate, Prometheus and friends.

Configuration lives in ``config.py`` and is read entirely from the environment;
see ``.env.example``. Any data source you leave unconfigured is skipped, and the
dashboard renders without that layer.
"""
import os
import time, threading, urllib3, re, socket
import requests
from flask import Flask, jsonify, render_template, request, Response

import config

urllib3.disable_warnings()

# --- resolved configuration (see config.py / .env.example) ---
OLLAMA = config.OLLAMA_URL
OLLAMA_MODEL = config.OLLAMA_MODEL
FRIGATE = config.FRIGATE_URL
ZBX_URL = config.ZBX_URL
ZBX_USER, ZBX_PASS = config.ZBX_USER, config.ZBX_PASS
UNIFI = config.UNIFI_URL
UNIFI_USER, UNIFI_PASS = config.UNIFI_USER, config.UNIFI_PASS
GRAFANA = config.GRAFANA_URL
GRAFANA_TOKEN = config.GRAFANA_TOKEN
GRAFANA_HEADERS = {"Authorization": "Bearer " + GRAFANA_TOKEN} if GRAFANA_TOKEN else {}
PROM = config.PROM_URL
NETMAP_URL = config.NETMAP_URL

REMOTE_GPU_EXPORTERS = config.REMOTE_GPU_EXPORTERS
AI_SERVERS = config.AI_SERVERS
PVE_NODES = config.PVE_NODES

# Optional NVIDIA telemetry. Absent GPU / absent driver must not stop the app.
_NGPU = 0
pynvml = None
gpu_render = None
if config.ENABLE_GPU:
    try:
        import pynvml
        pynvml.nvmlInit()
        _NGPU = pynvml.nvmlDeviceGetCount()
    except Exception as e:          # no NVIDIA card, no driver, or inside a CT without passthrough
        print("[gpu] NVML unavailable, GPU panels disabled:", e, flush=True)
        pynvml = None
if config.ENABLE_GPU_RENDER:
    try:
        import gpu_render
    except Exception as e:
        print("[gpu] server-side EGL render unavailable:", e, flush=True)
        gpu_render = None

CATS = [
    ("ai",      ["ollama","llm","openwebui","comfy","stable","whisper","qdrant","chroma","immich","frigate"]),
    ("media",   ["emby","jellyfin","plex","tdarr","threadfin","sonarr","radarr","lidarr","bazarr","prowlarr","transmission","qbit","sabnzbd","nextpvr","navidrome","audiobook"]),
    ("network", ["pihole","adguard","technitium","dns","unbound","nginx","npm","traefik","caddy","cloudflar","wireguard","tailscale","freeradius","openldap","ldap","guacamole","omada","unifi"]),
    ("monitor", ["zabbix","grafana","prometheus","loki","influx","checkmk","librenms","netdata","uptime","monitor","speedtest","ntopng","cockpit","noc"]),
    ("web",     ["dashboard","dashy","homarr","homepage","heimdall","wiki","bookstack","mail","portal","vault","nextcloud","paperless","actual","stirling","gitea","forgejo","homeassist","obsidian"]),
    ("infra",   ["docker","podman","k3s","backup","pbs","borg","restic","proxmox","iventoy","minio","nfs","samba","postgres","mysql","mariadb","redis","runner","worker","scheduler","proxy"]),
]
def categorize(n):
    n=(n or "").lower()
    for c,ks in CATS:
        if any(k in n for k in ks): return c
    return "infra"

app = Flask(__name__)

def _parse_labels(raw):
    labels = {}
    for part in raw.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        labels[k.strip()] = v.strip().strip('"')
    return labels

def remote_gpu_stats():
    out = []
    metric_re = re.compile(r"^(nvidia_smi_[a-zA-Z0-9_]+)\{([^}]*)\}\s+(.+)$")
    for exporter in REMOTE_GPU_EXPORTERS:
        try:
            text = requests.get(exporter["url"], timeout=4).text
            by_uuid = {}
            for line in text.splitlines():
                m = metric_re.match(line)
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
                if "RTX" not in raw_name.upper() and raw_name == "3090":
                    raw_name = "RTX 3090"
                util = float(g.get("nvidia_smi_utilization_gpu_ratio", 0) or 0)
                if util <= 1:
                    util *= 100
                out.append({
                    "index": 100 + idx,
                    "host": exporter["host"],
                    "uuid": uuid,
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

def gpu_stats():
    if pynvml is None or _NGPU == 0:
        return remote_gpu_stats()
    out=[]
    for i in range(_NGPU):
        h=pynvml.nvmlDeviceGetHandleByIndex(i)
        m=pynvml.nvmlDeviceGetMemoryInfo(h); u=pynvml.nvmlDeviceGetUtilizationRates(h)
        try: temp=pynvml.nvmlDeviceGetTemperature(h,pynvml.NVML_TEMPERATURE_GPU)
        except Exception: temp=0
        try: pw=pynvml.nvmlDeviceGetPowerUsage(h)/1000.0
        except Exception: pw=0
        nm=pynvml.nvmlDeviceGetName(h); nm=nm.decode() if isinstance(nm,bytes) else nm
        out.append({"index":i,"host":"gpu","name":nm,"util":u.gpu,"mem_used":m.used//(1024*1024),
                    "mem_total":m.total//(1024*1024),"temp":temp,"power":round(pw,1)})
    out.extend(remote_gpu_stats())
    return out
def _avg_load():
    s=gpu_stats(); return (sum(g["util"] for g in s)/len(s)/100.0) if s else 0.0

def ai_server_status():
    gpus = remote_gpu_stats()
    out = []
    for server in AI_SERVERS:
        item = {"name": server["name"], "ip": server["ip"], "cat": "ai", "gpus": [g for g in gpus if g.get("host") == server["name"]]}
        try:
            r = requests.get(server["ollama"], timeout=4)
            item["ollama_up"] = r.status_code < 500
            item["models"] = len((r.json() or {}).get("models", [])) if item["ollama_up"] else 0
        except Exception:
            item["ollama_up"] = False
            item["models"] = 0
        try:
            metrics = requests.get(server["node"], timeout=4).text
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

DATA = {"guests":[],"storage":[],"nodes":[],"pools":[],"unifi":{},"zabbix":{},"cameras":[],"sources":{},"health":[],"netmap":{},"fleet":{},"ts":0}

def poll_pve():
    while True:
        guests=[]; storage=[]; nodes=[]; pools=[]
        for n in PVE_NODES:
            H={"Authorization":f"PVEAPIToken={n['token']}"}
            try:
                r=requests.get(f"{n['url']}/api2/json/cluster/resources?type=vm",headers=H,verify=False,timeout=5)
                for g in r.json().get("data",[]):
                    guests.append({"id":g.get("vmid"),"name":g.get("name",str(g.get("vmid"))),"type":g.get("type"),
                        "status":g.get("status"),"node":g.get("node",n["node"]),"cpu":round(g.get("cpu",0)*100,1),
                        "mem":g.get("mem",0),"maxmem":g.get("maxmem",1),"cat":categorize(g.get("name"))})
            except Exception as e: print("[pve]",n["node"],e,flush=True)
            try:
                r=requests.get(f"{n['url']}/api2/json/nodes/{n['node']}/storage",headers=H,verify=False,timeout=5)
                for s in r.json().get("data",[]):
                    if s.get("total"): storage.append({"node":n["node"],"name":s["storage"],"type":s.get("type"),
                        "used":s.get("used",0),"total":s.get("total",1),"pct":round(s.get("used",0)/max(s.get("total",1),1)*100,1)})
            except Exception as e: print("[pve-stor]",n["node"],e,flush=True)
            try:   # physical hypervisor vitals (cpu/mem/load/uptime) — the old NOC had these, the scene lacked them
                st=requests.get(f"{n['url']}/api2/json/nodes/{n['node']}/status",headers=H,verify=False,timeout=5).json().get("data",{})
                mem=st.get("memory",{}) or {}; la=st.get("loadavg",[0,0,0]) or [0,0,0]
                nodes.append({"node":n["node"],"cpu":round(st.get("cpu",0)*100,1),
                    "cores":(st.get("cpuinfo",{}) or {}).get("cpus",0),"mem_used":mem.get("used",0),
                    "mem_total":mem.get("total",1),"load":float(la[0]),"uptime":st.get("uptime",0)})
            except Exception as e: print("[pve-node]",n["node"],e,flush=True)
            try:   # ZFS pool HEALTH + fragmentation (so a DEGRADED array / failing disk shows, not just %used)
                for p in requests.get(f"{n['url']}/api2/json/nodes/{n['node']}/disks/zfs",headers=H,verify=False,timeout=5).json().get("data",[]):
                    pools.append({"node":n["node"],"name":p.get("name"),"health":p.get("health","?"),
                        "frag":p.get("frag",0),"alloc":p.get("alloc",0),"free":p.get("free",0),"size":p.get("size",1)})
            except Exception as e: print("[pve-zfs]",n["node"],e,flush=True)
        if guests: DATA["guests"]=sorted(guests,key=lambda x:(x["node"],x["cat"],x["id"]))
        if storage: DATA["storage"]=storage
        if nodes: DATA["nodes"]=nodes; DATA["pools"]=pools
        DATA["ts"]=time.time()
        time.sleep(6)

_unifi_s=None
def poll_unifi():
    global _unifi_s
    while True:
        try:
            if _unifi_s is None:
                _unifi_s=requests.Session()
                _unifi_s.post(f"{UNIFI}/api/auth/login",json={"username":UNIFI_USER,"password":UNIFI_PASS},verify=False,timeout=6)
            base=f"{UNIFI}/proxy/network/api/s/default"
            cl=_unifi_s.get(f"{base}/stat/sta",verify=False,timeout=6).json().get("data",[])
            if not cl:           # session expired (UDM returns empty, no exception) -> re-login next cycle, keep last-good
                _unifi_s=None; time.sleep(8); continue
            dv=_unifi_s.get(f"{base}/stat/device",verify=False,timeout=6).json().get("data",[])
            hp=_unifi_s.get(f"{base}/stat/health",verify=False,timeout=6).json().get("data",[])
            wan=next((h for h in hp if h.get("subsystem")=="wan"),{})
            # UDM firmware 5.x reports the WAN subsystem as "status", not "uplink_status"
            us=wan.get("uptime_stats",{}).get("WAN",{}) if isinstance(wan.get("uptime_stats"),dict) else {}
            DATA["unifi"]={"clients":len(cl),"wifi":sum(1 for c in cl if not c.get("is_wired")),
                "devices":len(dv),"wan_up":wan.get("status") or wan.get("uplink_status","?"),
                "rx":round(wan.get("rx_bytes-r",0)*8/1e6,1),"tx":round(wan.get("tx_bytes-r",0)*8/1e6,1),
                "isp":wan.get("isp_name",""),"wan_ip":wan.get("wan_ip",""),
                "latency":round(us.get("latency_average",0) or wan.get("latency",0) or 0)}
        except Exception as e:
            _unifi_s=None; DATA["unifi"]=DATA.get("unifi") or {"error":str(e)[:60]}
        time.sleep(8)

def poll_zbx():
    while True:
        try:
            tok=requests.post(ZBX_URL,json={"jsonrpc":"2.0","method":"user.login",
                "params":{"username":ZBX_USER,"password":ZBX_PASS},"id":1},timeout=8).json().get("result")
            if tok:
                H={"Authorization":f"Bearer {tok}"}
                hosts=requests.post(ZBX_URL,headers=H,json={"jsonrpc":"2.0","method":"host.get","params":{"countOutput":True},"id":2},timeout=8).json().get("result")
                probs=requests.post(ZBX_URL,headers=H,json={"jsonrpc":"2.0","method":"problem.get","params":{"output":["eventid","name","severity","objectid","acknowledged"],"severities":[2,3,4,5],"suppressed":False},"id":3},timeout=8).json().get("result",[])
                # map triggers -> host names, build per-host alert feed for planet flares
                trigids=list({p.get("objectid") for p in probs if p.get("objectid")})
                tmap={}
                if trigids:
                    # "monitored":True mirrors what the Zabbix UI shows - it drops problems whose
                    # host or item is disabled, which otherwise inflate the alert count forever.
                    trg=requests.post(ZBX_URL,headers=H,json={"jsonrpc":"2.0","method":"trigger.get","params":{"triggerids":trigids,"monitored":True,"selectHosts":["host"],"output":["triggerid"]},"id":4},timeout=4+4).json().get("result",[])
                    for t in trg: tmap[t["triggerid"]]=(t["hosts"][0]["host"] if t.get("hosts") else None)
                # keep only problems on still-monitored hosts (matches the Zabbix UI)
                probs=[p for p in probs if tmap.get(p.get("objectid"))]
                sev={}
                for p in probs: sev[int(p.get("severity",0))]=sev.get(int(p.get("severity",0)),0)+1
                alert_hosts={}
                for p in probs:
                    hn=tmap.get(p.get("objectid"))
                    if not hn: continue
                    a=alert_hosts.setdefault(hn,{"sev":0,"n":0,"unack":0,"names":[]})
                    a["sev"]=max(a["sev"],int(p.get("severity",0))); a["n"]+=1
                    if str(p.get("acknowledged"))!="1": a["unack"]+=1
                    if len(a["names"])<3: a["names"].append(p.get("name","")[:60])
                DATA["zabbix"]={"hosts":int(hosts or 0),"problems":len(probs),"sev":sev,"alert_hosts":alert_hosts}
            else:
                DATA["zabbix"]={"error":"auth"}
        except Exception as e:
            DATA["zabbix"]={"error":str(e)[:60]}
        time.sleep(15)

def poll_cams():
    while True:
        try:
            cfg=requests.get(f"{FRIGATE}/api/config",timeout=6).json()
            DATA["cameras"]=list(cfg.get("cameras",{}).keys())
        except Exception: pass
        time.sleep(30)

def poll_sources():
    while True:
        s={}
        # Zabbix items/triggers (reuse a fresh login)
        try:
            tok=requests.post(ZBX_URL,json={"jsonrpc":"2.0","method":"user.login","params":{"username":ZBX_USER,"password":ZBX_PASS},"id":1},timeout=8).json().get("result")
            if tok:
                H={"Authorization":f"Bearer {tok}"}
                it=requests.post(ZBX_URL,headers=H,json={"jsonrpc":"2.0","method":"item.get","params":{"countOutput":True,"monitored":True},"id":2},timeout=10).json().get("result")
                tr=requests.post(ZBX_URL,headers=H,json={"jsonrpc":"2.0","method":"trigger.get","params":{"countOutput":True},"id":3},timeout=10).json().get("result")
                s["zabbix"]={"up":True,"items":int(it or 0),"triggers":int(tr or 0),"hosts":(DATA.get("zabbix") or {}).get("hosts"),"problems":(DATA.get("zabbix") or {}).get("problems")}
            else: s["zabbix"]={"up":False}
        except Exception: s["zabbix"]={"up":False}
        # Grafana
        try:
            ds=requests.get(f"{GRAFANA}/api/datasources",headers=GRAFANA_HEADERS,timeout=6).json()
            db=requests.get(f"{GRAFANA}/api/search?type=dash-db",headers=GRAFANA_HEADERS,timeout=6).json()
            s["grafana"]={"up":True,"datasources":len(ds),"dashboards":len(db),"ds":[d.get("type") for d in ds]}
        except Exception: s["grafana"]={"up":False}
        # Prometheus
        try:
            up=requests.get(f"{PROM}/api/v1/query?query=up",timeout=6).json()["data"]["result"]
            s["prometheus"]={"up":True,"targets":len(up),"healthy":sum(1 for x in up if x["value"][1]=="1")}
        except Exception: s["prometheus"]={"up":False}
        DATA["sources"]=s
        time.sleep(30)

# Service health pips. Configured via SVC_<n>_* env vars (see .env.example).
HEALTH = config.SERVICE_PROBES
def poll_health():
    while True:
        out=[]
        for name,cat,url in HEALTH:
            t0=time.time()
            try:
                r=requests.get(url,timeout=5,verify=False)
                out.append({"name":name,"cat":cat,"up":r.status_code<500,"ms":int((time.time()-t0)*1000),"code":r.status_code})
            except Exception:
                out.append({"name":name,"cat":cat,"up":False,"ms":int((time.time()-t0)*1000),"code":0})
        DATA["health"]=out
        time.sleep(20)

import sqlite3
DBPATH = config.METRICS_DB
def _db():
    c = sqlite3.connect(DBPATH, timeout=10); c.execute("PRAGMA journal_mode=WAL"); return c
def sampler():
    c = _db()
    c.execute("CREATE TABLE IF NOT EXISTS gpu(ts INT, idx INT, util INT, mem INT, temp INT, power REAL)")
    c.execute("CREATE TABLE IF NOT EXISTS guest(ts INT, id INT, cpu REAL, mem INT)")
    c.execute("CREATE TABLE IF NOT EXISTS net(ts INT, clients INT, rx REAL, tx REAL, problems INT)")
    c.execute("CREATE INDEX IF NOT EXISTS i_gpu ON gpu(idx,ts)")
    c.execute("CREATE INDEX IF NOT EXISTS i_guest ON guest(id,ts)")
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
            cut = now - (config.HISTORY_DAYS * 86400)
            for t in ("gpu", "guest", "net"): c.execute(f"DELETE FROM {t} WHERE ts<?", (cut,))
            c.commit(); c.close()
        except Exception as e:
            print("[sampler]", e, flush=True)
        time.sleep(30)

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
        elif request.args.get("metric") == "net":
            out = [{"ts": r[0], "clients": r[1], "rx": r[2], "tx": r[3], "problems": r[4]} for r in
                   c.execute("SELECT ts,clients,rx,tx,problems FROM net WHERE ts>? ORDER BY ts", (cut,)).fetchall()]
    finally:
        c.close()
    return jsonify(out)

@app.route("/")
def index(): return render_template("index.html")
@app.route("/desk")
def desk(): return render_template("desk.html")
@app.route("/api/topology")
def api_topology(): return jsonify(DATA.get("topology") or {})
@app.route("/api/gpu")
def api_gpu():
    render_backend = "disabled"
    if gpu_render is not None:
        render_backend = getattr(getattr(gpu_render, "_renderer", None), "renderer", "init")
    return jsonify({"gpus": gpu_stats(), "render_backend": render_backend})
@app.route("/api/all")
def api_all():
    g=DATA["guests"]
    return jsonify({"guests":g,"storage":DATA["storage"],"nodes":DATA["nodes"],"pools":DATA["pools"],"unifi":DATA["unifi"],"zabbix":DATA["zabbix"],
        "cameras":DATA["cameras"],"sources":DATA["sources"],"health":DATA["health"],"netmap":DATA["netmap"],"fleet":DATA["fleet"],"ai_servers":ai_server_status(),"total":len(g),"running":sum(1 for x in g if x["status"]=="running"),"ts":DATA["ts"],
        **{k:DATA.get(k) for k in ("nodes2","zfs","backups","frigate","top","certs","zbx2","latency","topology") if DATA.get(k) is not None}})
@app.route("/cam/<name>.jpg")
def cam(name):
    if not FRIGATE:
        return Response(status=404)
    try:
        r=requests.get(f"{FRIGATE}/api/{name}/latest.jpg?h=360",timeout=6)
        return Response(r.content,mimetype="image/jpeg")
    except Exception:
        return Response(b"",mimetype="image/jpeg")
@app.route("/api/chat",methods=["POST"])
def api_chat():
    msg=(request.json or {}).get("message","")
    if not OLLAMA:
        return jsonify({"reply":"(chat disabled: OLLAMA_URL is not configured)"})
    try:
        r=requests.post(f"{OLLAMA}/api/generate",json={"model":OLLAMA_MODEL,"prompt":msg,"stream":False},timeout=120)
        return jsonify({"reply":r.json().get("response","").strip()})
    except Exception as e:
        return jsonify({"reply":f"(ollama unavailable: {e})"})


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


def start_background_pollers():
    for fn in (poll_pve, poll_unifi, poll_zbx, poll_cams, poll_sources,
               poll_health, poll_netmap, poll_fleet, sampler):
        threading.Thread(target=fn, daemon=True).start()
    for name, mod in (("pollers", "pollers"), ("topology", "topology")):
        try:
            m = __import__(mod)
            getattr(m, "start_new_pollers", getattr(m, "start_topology_poller", None))(DATA)
            print(f"[{name}] started", flush=True)
        except Exception as e:
            print(f"[{name}] not started: {e}", flush=True)
    if gpu_render is not None:
        try:
            gpu_render.start(_avg_load)
        except Exception as e:
            print("[gpu_render] not started:", e, flush=True)


if __name__ == "__main__":
    problems = config.missing_required()
    if problems:
        print("Configuration incomplete — the dashboard cannot start:\n", flush=True)
        for p in problems:
            print("  *", p, flush=True)
        print("\nCopy .env.example to .env, fill it in, and re-run.", flush=True)
        raise SystemExit(1)
    start_background_pollers()
    app.run(host=config.LISTEN_HOST, port=config.LISTEN_PORT, threaded=True)
