"""demo.py - run the whole dashboard with NO infrastructure behind it.

    DEMO=1 python3 app.py          # then open http://localhost:8080 and /nexus

Demo mode replaces every poller with a feed that loads the anonymised fixtures
in ``demo/fixtures/`` (a real estate's API responses with every name, address
and MAC rewritten - see docs/demo.md) and then keeps them ALIVE: CPU and
throughput drift, GPU load breathes, the WAN edge sees requests and viewers,
and every minute or so a new "intrusion" arrives on the threat feed so both
screens (the wall and the 4K /nexus view) go through their full beat: streak,
shield burst, red caption, room-light pulse.

Nothing here talks to the network. The routes that ``showtime.py`` and
``threats.py`` normally own (/api/showtime, /api/mode, /api/presence,
/api/threats and their SSE streams) are provided by ``install()`` with the same
contracts, so the front end cannot tell the difference. Everything that app.py
serves straight from ``DATA`` (/api/all, /api/topology, /api/lightstate, the
pulse stream, the DOOM takeover) works unchanged.

Use it to try the dashboard before configuring anything, to take screenshots
without exposing your network, and as the fixture set for the front-end tests.
"""
import copy
import json
import math
import os
import random
import threading
import time

from flask import Response, jsonify, request, send_file

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURES = os.environ.get("DEMO_FIXTURES", os.path.join(HERE, "demo", "fixtures"))
CAM_IMAGE = os.path.join(HERE, "static", "demo", "cam.jpg")
TICK_S = 4.0
THREAT_EVERY_S = float(os.environ.get("DEMO_THREAT_EVERY", "75"))   # mean seconds between demo intrusions (0 = never)
MODES = ("wall", "showcase", "ops", "night", "alert")

_rnd = random.Random(20260919)
_lock = threading.Lock()
_cond = threading.Condition(_lock)
_state = {"mode": {"mode": "wall", "prev": "wall", "by": "demo", "id": 1, "ts": 0.0, "auto": False, "reason": None},
          "presence": {"active": True, "by": "demo", "id": 1, "ts": 0.0, "hold_until": 0.0},
          "threats": None, "version": 0}


def _load(name):
    with open(os.path.join(FIXTURES, name)) as fh:
        return json.load(fh)


def _wobble(v, pct, lo=0.0, hi=None):
    """Multiplicative drift: +/- pct of the value, clamped."""
    if v is None:
        return None
    out = float(v) * (1.0 + _rnd.uniform(-pct, pct))
    if hi is not None:
        out = min(hi, out)
    return max(lo, out)


class Feed:
    """Loads the fixtures into DATA and drifts them on a timer."""

    def __init__(self, data):
        self.DATA = data
        self.t0 = time.time()
        self.n = 0
        allj = _load("all.json")
        self.base_guests = copy.deepcopy(allj["guests"])
        for k, v in allj.items():
            data[k] = v
        data["topology"] = _load("topology.json")
        self.base_topology = copy.deepcopy(data["topology"])
        st = _load("showtime.json")
        # the anonymiser renamed the media server and the GPU host in the snapshot;
        # the API keys the screens read are `emby` and `frigate.gpu` (showtime.py)
        if "emby" not in st and "jellyfin" in st:
            st["emby"] = st["jellyfin"]
        fr = st.get("frigate") or {}
        if "gpu" not in fr:
            node_names = {n.get("node") for n in allj.get("nodes") or []}
            for k in list(fr):
                if k in node_names:
                    fr["gpu"] = fr.pop(k)
                    break
        data["showtime"] = st
        try:
            m = _load("mode.json")
            if m.get("mode") in MODES and m["mode"] != "alert":
                _state["mode"].update({"mode": m["mode"], "prev": m.get("prev") if m.get("prev") in MODES else "wall"})
        except Exception:
            pass
        data["gpu"] = _load("gpu.json")
        data["telemetry"] = _load("telemetry.json")
        data["inventory"] = _load("inventory.json")
        threats = _load("threats.json")
        # every fixture event becomes a template; the live timeline starts with the
        # newest few (aged so they read as "a while ago") and grows from there
        self.threat_pool = [e for e in threats.get("events", []) if e.get("src") == "crowdsec"]
        self.secmon_pool = [e for e in threats.get("events", []) if e.get("src") == "secmon"]
        now = time.time()
        events = []
        for i, e in enumerate(threats.get("events", [])[:6]):
            e = dict(e); e["ts"] = int(now - 600 - i * 900); e["id"] = f"demo:{i}"
            events.append(e)
        threats["events"] = events
        threats["seq"] = 0
        threats["latest"] = events[0] if events else None
        threats["ts"] = now
        data["edge"]["threats"] = threats
        _state["threats"] = threats
        self.next_threat = now + (THREAT_EVERY_S * _rnd.uniform(0.6, 1.4) if THREAT_EVERY_S > 0 else 1e12)
        self.threat_n = 10
        # history: shift the fixture series so the last sample is "now"
        self.hist = {"net": _load("history_net.json"), "gpu": _load("history_gpu.json")}
        for _key, rows in self.hist.items():
            if rows:
                shift = int(now) - rows[-1]["ts"]
                for r in rows:
                    r["ts"] += shift
        data["ts"] = now

    # ------------------------------------------------------------ drift
    def tick(self):
        D = self.DATA
        now = time.time()
        self.n += 1
        breath = 0.5 + 0.5 * math.sin((now - self.t0) / 47.0)          # slow estate-wide swell
        D["ts"] = now
        for g, b in zip(D["guests"], self.base_guests, strict=False):
            if g.get("status") == "running":
                g["cpu"] = round(max(0.2, _wobble(b.get("cpu") or 2.0, 0.35) * (0.7 + 0.6 * breath)), 1)
                g["mem"] = int(_wobble(b.get("mem") or 0, 0.03))
        for nd in D.get("nodes") or []:
            nd["cpu"] = round(max(1.0, _wobble(nd.get("cpu") or 10, 0.15)), 1)
            nd["load"] = round(max(0.1, _wobble(nd.get("load") or 1, 0.15)), 2)
        for nd in D.get("nodes2") or []:
            nd["cpu"] = round(max(1.0, _wobble(nd.get("cpu") or 10, 0.15)), 1)
        # topology throughput
        T, B = D.get("topology") or {}, self.base_topology
        tot, btot = T.get("totals") or {}, B.get("totals") or {}
        for k in ("wan_rx_bps", "wan_tx_bps", "lan_bps"):
            if btot.get(k) is not None:
                tot[k] = round(_wobble(btot[k], 0.35) * (0.6 + 0.8 * breath), 1)
        for L, bL in zip(T.get("links") or [], B.get("links") or [], strict=False):
            if bL.get("bps") is not None:
                L["bps"] = round(_wobble(bL["bps"], 0.3), 1)
        for F, bF in zip(T.get("flows") or [], B.get("flows") or [], strict=False):
            if bF.get("bps") is not None:
                F["bps"] = round(_wobble(bF["bps"], 0.3), 1)
        for n, bn in zip(T.get("nodes") or [], B.get("nodes") or [], strict=False):
            for k in ("rx", "tx"):
                if bn.get(k) is not None:
                    n[k] = round(_wobble(bn[k], 0.3), 1)
            m, bm = n.get("meta") or {}, bn.get("meta") or {}
            if bm.get("rtt") is not None:
                m["rtt"] = round(max(0.1, _wobble(bm["rtt"], 0.25)), 2)
        T["ts"] = now
        # GPUs breathe
        for i, g in enumerate((D.get("gpu") or {}).get("gpus") or []):
            u = 8 + 30 * (0.5 + 0.5 * math.sin((now - self.t0) / (23.0 + 9 * i))) + _rnd.uniform(-4, 4)
            g["util"] = int(max(0, min(100, u)))
            g["temp"] = int(38 + g["util"] * 0.3 + _rnd.uniform(-1, 1))
            g["power"] = round(30 + g["util"] * 2.2 + _rnd.uniform(-3, 3), 1)
        st = D.get("showtime") or {}
        series = (st.get("gpu_series") or {}).get("gpus") or []
        for i, s in enumerate(series):
            gpus = (D.get("gpu") or {}).get("gpus") or []
            if i < len(gpus):
                for key, val in (("util", gpus[i]["util"]), ("temp", gpus[i]["temp"]), ("mem", gpus[i].get("mem_used"))):
                    if key in s and isinstance(s[key], list) and val is not None:
                        s[key].append(val); del s[key][:-120]
        st["ts"] = now
        # the edge: requests, in-flight, viewers
        E = D.get("edge") or {}
        cf = E.get("cloudflare") or {}
        if cf:
            cf["req_per_min"] = round(max(0.5, 6 + 14 * breath + _rnd.uniform(-2, 2)), 2)
            cf["active_streams"] = max(0, int(round(breath * 3 + _rnd.uniform(-0.5, 0.5))))
            cf["ts"] = now
        au = E.get("audience") or {}
        if au:
            au["viewers_5m"] = max(1, int(round(2 + 4 * breath + _rnd.uniform(-1, 1))))
            au["requests_5m"] = au["viewers_5m"] * _rnd.randint(3, 11)
            au["viewers_1h"] = max(au["viewers_5m"], 9 + int(6 * breath))
            au["requests_1h"] = au["viewers_1h"] * 14
            au["ts"] = now; au["up"] = True
        # rolling history
        u = D.get("unifi") or {}
        self.hist["net"].append({"ts": int(now), "clients": u.get("clients", 0),
                                 "rx": round((tot.get("wan_rx_bps") or 0) / 1e6, 2), "tx": round((tot.get("wan_tx_bps") or 0) / 1e6, 2),
                                 "problems": (D.get("zabbix") or {}).get("problems", 0)})
        del self.hist["net"][:-1500]
        gp = ((D.get("gpu") or {}).get("gpus") or [None])[0]
        if gp:
            self.hist["gpu"].append({"ts": int(now), "util": gp["util"], "mem": gp.get("mem_used"), "temp": gp["temp"], "power": gp["power"]})
            del self.hist["gpu"][:-1500]
        # a new intrusion, now and then
        if now >= self.next_threat and self.threat_pool:
            self.push_threat()
            self.next_threat = now + THREAT_EVERY_S * _rnd.uniform(0.6, 1.4)

    def push_threat(self, evt=None):
        """Append one event to the timeline and wake the SSE stream (also used by /api/threats/demo)."""
        th = _state["threats"]
        if evt is None:
            src = self.secmon_pool if (self.secmon_pool and _rnd.random() < 0.12) else self.threat_pool
            evt = dict(_rnd.choice(src))
        self.threat_n += 1
        evt = dict(evt); evt["ts"] = int(time.time()); evt["id"] = evt.get("id") or f"demo:{self.threat_n}"
        with _cond:
            th["events"].insert(0, evt); del th["events"][40:]
            th["seq"] += 1; th["latest"] = evt; th["ts"] = time.time()
            th["level"] = 2 if evt.get("sev", 2) >= 2 else 1
            th["name"] = {0: "GREEN", 1: "YELLOW", 2: "RED", 3: "BLACK"}[th["level"]]
            c = th.setdefault("counts", {})
            c["crowdsec_1h"] = (c.get("crowdsec_1h") or 0) + (1 if evt.get("src") == "crowdsec" else 0)
            c["crowdsec_24h"] = (c.get("crowdsec_24h") or 0) + (1 if evt.get("src") == "crowdsec" else 0)
            _cond.notify_all()
        return evt

    def run(self):
        while True:
            try:
                self.tick()
            except Exception as e:      # a bad tick must never stop the feed
                print("[demo] tick:", e, flush=True)
            time.sleep(TICK_S)


# ---------------------------------------------------------------- routes
def _sse(body_fn, key_fn, keepalive=15):
    def gen():
        yield "retry: 3000\n\n"
        last = None
        while True:
            with _cond:
                _cond.wait_for(lambda: key_fn() != last, timeout=keepalive)  # noqa: B023 - called at once
                cur = key_fn()
                body = body_fn() if cur != last else None
            if body is not None:
                last = cur
                yield "data: " + json.dumps(body) + "\n\n"
            else:
                yield ": keepalive\n\n"
    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})


def _mode_body():
    m = dict(_state["mode"]); m["modes"] = list(MODES); m["alert_sev"] = 3
    return m


def _presence_body():
    p = dict(_state["presence"]); p["effective"] = bool(p["active"]) or time.time() < p["hold_until"]
    p["hold_s"] = max(0, round(p["hold_until"] - time.time())); p["grace_s"] = 0
    return p


def install(app, data):
    """Load the fixtures into ``data``, start the drift thread, register the demo routes."""
    feed = Feed(data)
    threading.Thread(target=feed.run, daemon=True, name="demo-feed").start()

    @app.route("/api/showtime")
    def demo_showtime():
        st = dict(data.get("showtime") or {}); st["mode"] = _mode_body(); st["demo"] = True
        st["ts"] = round(time.time(), 3); st["served_ms"] = 0.0
        return jsonify(st)

    @app.route("/api/mode", methods=["GET", "POST"])
    def demo_mode():
        if request.method == "POST":
            d = request.get_json(silent=True) or request.form.to_dict() or {}
            m = str(d.get("mode", "")).lower()
            if m not in MODES:
                return jsonify({"ok": False, "err": "mode must be one of " + ", ".join(MODES)}), 400
            with _cond:
                s = _state["mode"]
                if m != s["mode"]:
                    s["prev"] = s["mode"]; s["mode"] = m; s["id"] += 1; s["ts"] = time.time(); s["by"] = "api"
                    _state["version"] += 1; _cond.notify_all()
            return jsonify(dict(_mode_body(), ok=True))
        return jsonify(_mode_body())

    @app.route("/api/mode/stream")
    def demo_mode_stream():
        return _sse(_mode_body, lambda: _state["mode"]["id"])

    @app.route("/api/presence", methods=["GET", "POST"])
    def demo_presence():
        if request.method == "POST":
            d = request.get_json(silent=True) or request.form.to_dict() or {}
            raw = d.get("active", True)
            active = raw.lower() in ("1", "true", "on", "yes") if isinstance(raw, str) else bool(raw)
            with _cond:
                p = _state["presence"]
                p["active"] = active; p["id"] += 1; p["ts"] = time.time(); p["by"] = "api"
                try:
                    p["hold_until"] = time.time() + max(0, min(86400, int(float(d.get("hold", 0)))))
                except (TypeError, ValueError):
                    pass
                _cond.notify_all()
            return jsonify(dict(_presence_body(), ok=True))
        return jsonify(_presence_body())

    @app.route("/api/presence/stream")
    def demo_presence_stream():
        return _sse(_presence_body, lambda: (_state["presence"]["id"], _presence_body()["effective"]))

    @app.route("/api/threats")
    def demo_threats():
        with _lock:
            return jsonify(dict(_state["threats"]))

    @app.route("/api/threats/stream")
    def demo_threats_stream():
        return _sse(lambda: dict(_state["threats"]), lambda: _state["threats"]["seq"])

    @app.route("/api/threats/demo", methods=["POST"])
    def demo_threats_push():
        """Fire an intrusion on demand (QA / videos): POST {} or a full event object."""
        d = request.get_json(silent=True) or {}
        evt = feed.push_threat(d if d.get("title") else None)
        return jsonify({"ok": True, "event": evt, "seq": _state["threats"]["seq"]})

    @app.route("/api/gpu")
    def demo_gpu():
        return jsonify({"gpus": (data.get("gpu") or {}).get("gpus") or [], "render_backend": "demo"})

    @app.route("/api/history")
    def demo_history():
        mins = int(request.args.get("mins", 120)); cut = int(time.time()) - mins * 60
        metric = request.args.get("metric")
        if request.args.get("guest"):
            rows = [{"ts": r["ts"], "cpu": round(_wobble(6, 0.8), 1), "mem": 512 * 1024 * 1024} for r in feed.hist["net"] if r["ts"] > cut]
        elif metric == "gpu":
            rows = [r for r in feed.hist["gpu"] if r["ts"] > cut]
        elif metric == "rtt":
            rows = [{"ts": r["ts"], "rtt": round(_wobble(0.6, 0.5), 3), "jitter": 0.1, "loss": 0} for r in feed.hist["net"] if r["ts"] > cut]
        else:
            rows = [r for r in feed.hist["net"] if r["ts"] > cut]
        return jsonify(rows)

    @app.route("/api/inventory")
    def demo_inventory():
        return jsonify(data.get("inventory") or {})

    @app.route("/api/telemetry")
    def demo_telemetry():
        return jsonify(data.get("telemetry") or {})

    @app.route("/api/rtt/baseline")
    def demo_rtt_baseline():
        return jsonify({"win": 21600, "min_n": 20, "ips": {}})

    @app.route("/api/prom")
    def demo_prom():
        return jsonify({"up": False, "demo": True})

    @app.route("/cam/<name>.jpg")
    @app.route("/frigate/thumb/<name>.jpg")
    def demo_cam(name):
        return send_file(CAM_IMAGE, mimetype="image/jpeg", max_age=5)

    @app.route("/api/chat", methods=["POST"])
    def demo_chat():
        msg = (request.get_json(silent=True) or {}).get("message", "")
        return jsonify({"reply": "(demo mode - no LLM is connected) You asked: " + msg[:120]})

    print("[demo] fixtures loaded from", FIXTURES, "-", len(data.get("guests") or []), "guests,",
          len((data.get("topology") or {}).get("nodes") or []), f"topology nodes; a demo intrusion every ~{THREAT_EVERY_S:.0f} s", flush=True)
    return feed
