"""showtime.py — "showtime" feeds + display modes + presence for the wall.

Installed from app.py with showtime.install(app, DATA) (routes) and showtime.start(DATA) (pollers).

Everything here is cached and non-blocking: each upstream (the configured
Ollama instances, Frigate, Emby/Jellyfin, sysfs, NVML) is polled by its own
daemon thread with a hard 3 s timeout, and the request handlers only ever read
the last-good snapshot. A dead upstream degrades to `up: false` + empty lists —
never to a slow or failing request. Unconfigured upstreams are not polled.

  GET  /api/showtime            the bundle (ollama / frigate / emby / coral / gpu_series / mode)
  GET  /frigate/thumb/<id>.jpg  proxied + memoised Frigate event thumbnail
  GET  /api/mode                current display mode
  POST /api/mode  {"mode": m}   set it (wall | showcase | ops | night | alert)
  GET  /api/mode/stream         SSE: one event per mode change (+ keepalives)
  GET  /api/presence            {active, effective, hold_s, grace_s, ts, by}
  POST /api/presence  {"active": bool, "hold": secs?}   motion/button automations
                                (deploy/homeassistant/presence.yaml.example):
                                a positive report holds the wall awake for
                                grace_s (PRESENCE_GRACE_S) so a sensor's own
                                short occupancy hold cannot drop it mid-visit;
                                {"active": false, "hold": 0} sleeps it at once
  GET  /api/presence/stream     SSE: one event per presence change (+ keepalives)

Modes persist in MODE_FILE (DATA_DIR) so a service restart comes back the way
it was left. Presence does NOT persist across a restart — it always boots
"active" (fail open), and is_presence_active() also treats a stale "inactive"
reading (no POST in PRESENCE_STALE_S) as active, so a missed automation call can
never wedge the wall paused with nobody around to notice.
`alert` is also entered AUTOMATICALLY: see _auto_alert() for the rule. It is a
rising-edge detector against a baseline, because an estate that carries
standing Zabbix problems around the clock would otherwise sit in red forever.

Secrets (EMBY_API_KEY) come from config and are never echoed into any payload or log.
"""
import collections
import glob
import json
import os
import re
import threading
import time

import requests

import config

OLLAMA_INSTANCES = config.OLLAMA_INSTANCES
FRIGATE = config.FRIGATE_URL
EMBY_URL = config.EMBY_URL
EMBY_KEY = config.EMBY_API_KEY
TIMEOUT = 3
MODE_FILE = config.MODE_FILE
MODES = ("wall", "showcase", "ops", "night", "alert")
# An automation that re-sends the current state on a timer (e.g. every 2 min)
# only goes stale if it has been silent for several sweeps.
PRESENCE_STALE_S = config.PRESENCE_STALE_S
# How long one motion report keeps the wall awake. Must be >> the sensor's own
# occupancy hold or the wall drops while the room is still occupied.
PRESENCE_GRACE_S = config.PRESENCE_GRACE_S
ALERT_SEV = config.ALERT_SEV           # zabbix severity that can trip alert mode
ALERT_MAX_S = 180                      # auto-alert dwell ceiling; after this the new problems become the baseline
# triggers that mean "busy", not "broken" (a media server's hourly library scan
# raising High CPU, say). A host only counts if at least one of its problems is NOT ignored.
try:
    ALERT_IGNORE = re.compile(config.ALERT_IGNORE or r"^High CPU", re.I)
except re.error:
    ALERT_IGNORE = re.compile(r"^High CPU", re.I)
SERIES_N = 60                          # rolling 1 Hz window for the gpu series

_lock = threading.Lock()
SHOW = {
    "ollama": [], "frigate": {"up": False}, "emby": {"up": False, "sessions": [], "playing": []},
    "coral": {"usb": False, "detector": None, "inference_ms": None},
    "gpu_series": {"n": 0, "gpus": []},
    "polled": {},
}
_thumbs = collections.OrderedDict()      # event id -> jpeg bytes (LRU, 64)
_THUMB_MAX = 64
_RE_EVENT = re.compile(r"^[0-9]{6,}\.[0-9]+-[a-z0-9]{4,12}$")


def _set(key, value):
    with _lock:
        SHOW[key] = value
        SHOW["polled"][key] = round(time.time(), 1)


# ---------------------------------------------------------------- ollama ----
def _poll_ollama():
    seen = {}      # (instance, model) -> last expires_at; a change means it was just used
    busy = {}      # (instance, model) -> busy_until
    while True:
        out = []
        for inst in OLLAMA_INSTANCES:
            name, url = inst["name"], inst["url"]
            item = {"name": name, "url": url, "gpus": inst.get("gpus") or [], "gpu_label": inst.get("label") or "",
                    "up": False, "loaded": [], "available": 0, "vram_used_mb": 0}
            try:
                ps = requests.get(url + "/api/ps", timeout=TIMEOUT).json()
                item["up"] = True
                now = time.time()
                for m in ps.get("models", []) or []:
                    k = (name, m.get("name"))
                    exp = m.get("expires_at")
                    if k in seen and seen[k] != exp:
                        busy[k] = now + 8          # keep-alive was refreshed => a request just ran
                    seen[k] = exp
                    d = m.get("details") or {}
                    item["loaded"].append({
                        "name": m.get("name"), "family": d.get("family"),
                        "params": d.get("parameter_size"), "quant": d.get("quantization_level"),
                        "size_mb": int((m.get("size") or 0) / 1048576),
                        "vram_mb": int((m.get("size_vram") or 0) / 1048576),
                        "ctx": m.get("context_length"),
                        "busy": busy.get(k, 0) > now,
                    })
                item["vram_used_mb"] = sum(x["vram_mb"] for x in item["loaded"])
                try:
                    tags = requests.get(url + "/api/tags", timeout=TIMEOUT).json()
                    item["available"] = len(tags.get("models", []) or [])
                except Exception:
                    pass
            except Exception as e:
                item["err"] = str(e)[:60]
            out.append(item)
        _set("ollama", out)
        time.sleep(4)


# --------------------------------------------------------------- frigate ----
def _poll_frigate():
    while True:
        d = {"up": False, "detector": None, "detector_type": None, "inference_ms": None,
             "detection_fps": None, "cameras": [], "events": []}
        try:
            st = requests.get(FRIGATE + "/api/stats", timeout=TIMEOUT).json()
            d["up"] = True
            dets = st.get("detectors") or {}
            if dets:
                dn = sorted(dets.keys())[0]
                d["detector"] = dn
                d["inference_ms"] = round(float(dets[dn].get("inference_speed") or 0), 2)
            d["detection_fps"] = st.get("detection_fps")
            for cn, c in sorted((st.get("cameras") or {}).items()):
                d["cameras"].append({"name": cn, "fps": c.get("camera_fps"), "det_fps": c.get("detection_fps"),
                                     "skipped": c.get("skipped_fps"), "enabled": c.get("detection_enabled", True)})
            gu = st.get("gpu_usages") or {}
            d["gpu"] = {k: v.get("gpu") for k, v in gu.items()} if isinstance(gu, dict) else {}
        except Exception as e:
            d["err"] = str(e)[:60]
        try:
            cfg = requests.get(FRIGATE + "/api/config", timeout=TIMEOUT).json()
            dets = cfg.get("detectors") or {}
            if dets:
                dn = sorted(dets.keys())[0]
                d["detector_type"] = (dets[dn] or {}).get("type")
                mp = ((dets[dn] or {}).get("model") or {}).get("path") or ""
                d["model"] = os.path.basename(mp).replace(".onnx", "").replace(".tflite", "") or None
        except Exception:
            pass
        try:
            ev = requests.get(FRIGATE + "/api/events?limit=8", timeout=TIMEOUT).json()
            now = time.time()
            for e in ev or []:
                eid = str(e.get("id") or "")
                if not _RE_EVENT.match(eid):
                    continue
                data = e.get("data") or {}
                score = e.get("top_score") or data.get("top_score") or data.get("score") or 0
                d["events"].append({
                    "id": eid, "camera": e.get("camera"), "label": e.get("label"),
                    "sub_label": e.get("sub_label"), "score": round(float(score) * 100),
                    "start": e.get("start_time"), "end": e.get("end_time"),
                    "age": round(now - float(e.get("start_time") or now)),
                    "ongoing": e.get("end_time") is None,
                    "thumb": f"/frigate/thumb/{eid}.jpg" if e.get("has_snapshot", True) else None,
                    "zones": e.get("zones") or [],
                })
        except Exception:
            pass
        _set("frigate", d)
        time.sleep(3)


# ------------------------------------------------------------------ emby ----
def _is_private(ip):
    try:
        p = [int(x) for x in str(ip).split(":")[0].split(".")]
    except ValueError:
        return True
    if len(p) != 4:
        return True
    return (p[0] == 10 or p[0] == 127 or (p[0] == 172 and 16 <= p[1] <= 31)
            or (p[0] == 192 and p[1] == 168) or (p[0] == 169 and p[1] == 254)
            or (p[0] == 100 and 64 <= p[1] <= 127))


def _emby_title(it):
    t = it.get("Type")
    if t == "Episode":
        s = it.get("SeriesName") or ""
        se, ep = it.get("ParentIndexNumber"), it.get("IndexNumber")
        tag = f"S{se:02d}E{ep:02d} " if (se is not None and ep is not None) else ""
        return (s + " · " + tag + (it.get("Name") or "")).strip(" ·")
    if t == "TvChannel":
        prog = (it.get("CurrentProgram") or {}).get("Name")
        return (it.get("Name") or "Live TV") + (" · " + prog if prog else "")
    if t == "Audio":
        artist = it.get("AlbumArtist") or (it.get("Artists") or [""])[0]
        return (artist + " · " + (it.get("Name") or "")).strip(" ·")
    return it.get("Name") or "?"


def _poll_emby():
    while True:
        d = {"up": False, "sessions": [], "playing": [], "count": 0, "configured": bool(EMBY_KEY and EMBY_URL)}
        if EMBY_KEY and EMBY_URL:
            try:
                # /emby/Sessions on Emby; Jellyfin answers the same call on /Sessions
                r = requests.get(EMBY_URL + "/emby/Sessions", headers={"X-Emby-Token": EMBY_KEY}, timeout=TIMEOUT)
                if r.status_code == 404:
                    r = requests.get(EMBY_URL + "/Sessions", headers={"X-Emby-Token": EMBY_KEY}, timeout=TIMEOUT)
                r.raise_for_status()
                sess = r.json() or []
                d["up"] = True
                d["count"] = len(sess)
                for s in sess:
                    rip = s.get("RemoteEndPoint") or ""
                    row = {"user": s.get("UserName") or "—", "client": s.get("Client"),
                           "device": s.get("DeviceName"), "remote": not _is_private(rip),
                           "ip": rip if _is_private(rip) else None}
                    d["sessions"].append(row)
                    it = s.get("NowPlayingItem")
                    if not it:
                        continue
                    ps = s.get("PlayState") or {}
                    ti = s.get("TranscodingInfo") or {}
                    method = ps.get("PlayMethod") or ("Transcode" if ti else "DirectPlay")
                    run = it.get("RunTimeTicks") or 0
                    pos = ps.get("PositionTicks") or 0
                    d["playing"].append(dict(row, **{
                        "title": _emby_title(it), "type": it.get("Type"),
                        "transcode": method == "Transcode", "method": method,
                        "paused": bool(ps.get("IsPaused")),
                        "bitrate_mbps": round((ti.get("Bitrate") or it.get("Bitrate") or 0) / 1e6, 1),
                        "video": (ti.get("VideoCodec") or ""), "audio": (ti.get("AudioCodec") or ""),
                        "hw": bool(ti.get("VideoDecoderIsHardware") or ti.get("VideoEncoderIsHardware")),
                        "progress": round(pos / run * 100, 1) if run else None,
                        "live": it.get("Type") == "TvChannel",
                    }))
            except Exception as e:
                d["err"] = str(e)[:60]
        _set("emby", d)
        time.sleep(4)


# ----------------------------------------------------------------- coral ----
def _poll_coral():
    while True:
        usb = False
        try:
            for v in glob.glob("/sys/bus/usb/devices/*/idVendor"):
                try:
                    with open(v) as fh:
                        vend = fh.read().strip()
                    with open(v.replace("idVendor", "idProduct")) as fh:
                        prod = fh.read().strip()
                except Exception:
                    continue
                # 18d1:9302 = Coral Edge TPU (runtime), 1a6e:089a = Global Unichip (pre-init)
                if (vend, prod) in (("18d1", "9302"), ("1a6e", "089a")):
                    usb = True
        except Exception:
            pass
        with _lock:
            f = SHOW.get("frigate") or {}
            SHOW["coral"] = {"usb": usb, "detector": f.get("detector"), "detector_type": f.get("detector_type"),
                             "model": f.get("model"), "inference_ms": f.get("inference_ms")}
            SHOW["polled"]["coral"] = round(time.time(), 1)
        time.sleep(15)


# ------------------------------------------------------------ gpu series ----
def _poll_gpu_series():
    try:
        import pynvml
        n = pynvml.nvmlDeviceGetCount()
    except Exception:
        return
    hist = [{"util": collections.deque(maxlen=SERIES_N), "power": collections.deque(maxlen=SERIES_N),
             "temp": collections.deque(maxlen=SERIES_N), "mem": collections.deque(maxlen=SERIES_N)} for _ in range(n)]
    names, totals = [], []
    for i in range(n):
        try:
            h = pynvml.nvmlDeviceGetHandleByIndex(i)
            nm = pynvml.nvmlDeviceGetName(h); nm = nm.decode() if isinstance(nm, bytes) else nm
            names.append(nm.replace("NVIDIA GeForce ", ""))
            totals.append(pynvml.nvmlDeviceGetMemoryInfo(h).total // 1048576)
        except Exception:
            names.append(f"GPU {i}"); totals.append(0)
    while True:
        try:
            for i in range(n):
                h = pynvml.nvmlDeviceGetHandleByIndex(i)
                u = pynvml.nvmlDeviceGetUtilizationRates(h).gpu
                try: p = pynvml.nvmlDeviceGetPowerUsage(h) / 1000.0
                except Exception: p = 0
                try: t = pynvml.nvmlDeviceGetTemperature(h, pynvml.NVML_TEMPERATURE_GPU)
                except Exception: t = 0
                m = pynvml.nvmlDeviceGetMemoryInfo(h).used // 1048576
                hist[i]["util"].append(int(u)); hist[i]["power"].append(round(p, 1))
                hist[i]["temp"].append(int(t)); hist[i]["mem"].append(int(m))
            series = {"n": SERIES_N, "step_s": 1, "gpus": [
                {"index": i, "name": names[i], "mem_total_mb": totals[i],
                 "util": list(hist[i]["util"]), "power": list(hist[i]["power"]),
                 "temp": list(hist[i]["temp"]), "mem": list(hist[i]["mem"])} for i in range(n)]}
            _set("gpu_series", series)
        except Exception:
            pass
        time.sleep(1)


# ------------------------------------------------------------------ mode ----
MODE = {"mode": "wall", "prev": "wall", "id": 0, "ts": 0.0, "auto": False, "reason": None, "by": "boot"}
_AA = {"base": None, "since": 0.0}      # auto-alert baseline + entry time

# Room occupancy, POSTed by a motion-sensor automation. Fails open:
# is_presence_active() ignores a stale "empty" reading so a missed POST
# (restart, network blip) can never wedge the wall paused.
PRESENCE = {"active": True, "id": 0, "ts": time.time(), "by": "boot", "hold_until": 0.0}


def _set_presence(active, by, hold=None):
    """`hold` seconds keeps the wall awake regardless of later negative reports.

    A motion sensor's occupancy typically clears within a minute of the last
    movement, and a PIR does not re-trigger for somebody standing still.
    Following it literally wakes the wall for under a minute at a time, so
    every positive report opens/extends a grace window instead of gating
    frame-by-frame.
    """
    active = bool(active)
    now = time.time()
    changed = False
    with _lock:
        if active:
            span = PRESENCE_GRACE_S if hold is None else hold
            PRESENCE["hold_until"] = max(PRESENCE["hold_until"], now + span)
        elif hold is not None:          # explicit sleep: {"active": false, "hold": 0}
            PRESENCE["hold_until"] = now + hold
        PRESENCE["ts"] = now
        if active != PRESENCE["active"]:
            PRESENCE.update({"active": active, "id": PRESENCE["id"] + 1, "by": by})
            changed = True
    if changed:
        print(f"[showtime] presence -> {active} ({by})", flush=True)
    return changed


def is_presence_active():
    with _lock:
        active, ts, hold_until = PRESENCE["active"], PRESENCE["ts"], PRESENCE["hold_until"]
    now = time.time()
    if now < hold_until:
        return True
    if not active and now - ts > PRESENCE_STALE_S:
        return True
    return active


def _presence_body():
    with _lock:
        body = dict(PRESENCE)
    body["effective"] = is_presence_active()
    body["hold_s"] = max(0, round(body["hold_until"] - time.time()))
    body["grace_s"] = PRESENCE_GRACE_S
    return body


def _load_mode():
    try:
        with open(MODE_FILE) as fh:
            j = json.load(fh)
        m = j.get("mode")
        if m in MODES and m != "alert":         # never boot straight into a red wall
            MODE["mode"] = m; MODE["prev"] = j.get("prev") if j.get("prev") in MODES else "wall"
    except Exception:
        pass


def _save_mode():
    try:
        tmp = MODE_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"mode": MODE["mode"], "prev": MODE["prev"], "ts": MODE["ts"]}, f)
        os.replace(tmp, MODE_FILE)
    except Exception as e:
        print("[showtime] mode save failed:", e, flush=True)


def _set_mode(mode, by, auto=False, reason=None):
    with _lock:
        if mode == MODE["mode"] and auto == MODE["auto"]:
            return False
        if mode == "alert" and MODE["mode"] != "alert":
            MODE["prev"] = MODE["mode"]
        MODE.update({"mode": mode, "id": MODE["id"] + 1, "ts": time.time(), "auto": auto,
                     "reason": reason, "by": by})
    _save_mode()
    print("[showtime] mode -> {} ({}{})".format(mode, by, " auto" if auto else ""), flush=True)
    return True


def _trigger_set(DATA):
    """Everything that could justify a red wall right now: zabbix hosts at or
    above ALERT_SEV, plus one token per SNMP device currently down."""
    z = DATA.get("zabbix") or {}
    s = set()
    for host, a in (z.get("alert_hosts") or {}).items():
        if int(a.get("sev") or 0) < ALERT_SEV:
            continue
        names = a.get("names") or []
        if names and all(ALERT_IGNORE.search(str(n)) for n in names):
            continue
        s.add("zbx:" + host)
    nm = DATA.get("netmap") or {}
    down = max(0, int(nm.get("total") or 0) - int(nm.get("up") or 0))
    for i in range(down):
        s.add(f"net_down:{i}")
    return s


def _auto_alert(DATA):
    """Rising-edge alert: a NEW sev>=ALERT_SEV problem or a NEW device down
    (relative to the baseline) flips the wall to `alert`; when those clear the
    previous mode returns. A manual POST always wins, and re-baselines so the
    same problem cannot immediately re-trip it. ALERT_MAX_S caps the dwell."""
    time.sleep(20)                       # let the zabbix / netmap pollers fill first
    while True:
        try:
            cur = _trigger_set(DATA)
            if _AA["base"] is None:
                _AA["base"] = set(cur)
            new = cur - _AA["base"]
            if MODE["auto"]:
                if not new or time.time() - _AA["since"] > ALERT_MAX_S:
                    _AA["base"] = set(cur)   # absorb; whatever is still open is the new normal
                    _set_mode(MODE["prev"] if MODE["prev"] in MODES and MODE["prev"] != "alert" else "wall",
                              "auto-clear")
            elif new and MODE["mode"] != "alert":
                _AA["since"] = time.time()
                _set_mode("alert", "auto", auto=True, reason=sorted(new)[:6])
            # standing problems that clear on their own shrink the baseline too
            _AA["base"] &= cur | new
        except Exception as e:
            print("[showtime] auto-alert:", e, flush=True)
        time.sleep(5)


# --------------------------------------------------------------- install ----
def install(app, DATA):
    from flask import Response, jsonify, request
    _load_mode()

    @app.after_request
    def _no_cache_html(resp):
        # the kiosk reloads on a fixed cadence; a cached HTML shell would pin old ?v= script tags
        if resp.mimetype == "text/html":
            resp.headers["Cache-Control"] = "no-cache, must-revalidate"
        return resp

    @app.route("/api/showtime")
    def api_showtime():
        t0 = time.time()
        with _lock:
            body = dict(SHOW)
            body["mode"] = dict(MODE)
        f = body.get("frigate") or {}
        if f.get("events"):
            now = time.time()
            f = dict(f); f["events"] = [dict(e, age=round(now - float(e.get("start") or now))) for e in f["events"]]
            body["frigate"] = f
        body["ts"] = round(t0, 3)
        body["served_ms"] = round((time.time() - t0) * 1000, 2)
        return jsonify(body)

    @app.route("/frigate/thumb/<eid>.jpg")
    def frigate_thumb(eid):
        if not FRIGATE or not _RE_EVENT.match(eid or ""):
            return Response(b"", status=404)
        with _lock:
            data = _thumbs.get(eid)
        if data is None:
            try:
                r = requests.get(FRIGATE + f"/api/events/{eid}/thumbnail.jpg", timeout=TIMEOUT)
                data = r.content if r.status_code == 200 and r.content else b""
            except Exception:
                data = b""
            if data:
                with _lock:
                    _thumbs[eid] = data
                    while len(_thumbs) > _THUMB_MAX:
                        _thumbs.popitem(last=False)
        return Response(data, mimetype="image/jpeg", status=200 if data else 404,
                        headers={"Cache-Control": "public, max-age=3600"})

    @app.route("/api/mode", methods=["GET", "POST"])
    def api_mode():
        if request.method == "POST":
            d = request.get_json(silent=True) or request.form.to_dict() or {}
            m = str(d.get("mode", "")).lower().strip()
            if m not in MODES:
                return jsonify({"ok": False, "err": "mode must be one of " + ", ".join(MODES), "modes": MODES}), 400
            # a human took the wheel: whatever is open right now is no longer "new"
            _AA["base"] = _trigger_set(DATA)
            changed = _set_mode(m, "api:" + (request.remote_addr or "?"))
            return jsonify(dict(MODE, ok=True, changed=changed, modes=MODES))
        return jsonify(dict(MODE, modes=MODES, alert_sev=ALERT_SEV))

    @app.route("/api/mode/stream")
    def api_mode_stream():
        def gen():
            yield "retry: 3000\n\n"
            last = None
            while True:
                cur = MODE["id"]
                if cur != last:
                    last = cur
                    yield "data: " + json.dumps(MODE) + "\n\n"
                else:
                    yield ": ka\n\n"
                time.sleep(0.25)
        return Response(gen(), mimetype="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})

    @app.route("/api/presence", methods=["GET", "POST"])
    def api_presence():
        if request.method == "POST":
            d = request.get_json(silent=True) or request.form.to_dict() or {}
            if "active" not in d:
                return jsonify({"ok": False, "err": "active required"}), 400
            raw = d.get("active")
            active = raw.lower() in ("1", "true", "on", "yes") if isinstance(raw, str) else bool(raw)
            hold = d.get("hold")
            if hold is not None:
                try:
                    hold = max(0, min(86400, int(float(hold))))
                except (TypeError, ValueError):
                    return jsonify({"ok": False, "err": "hold must be seconds"}), 400
            changed = _set_presence(active, "api:" + (request.remote_addr or "?"), hold)
            return jsonify(dict(_presence_body(), ok=True, changed=changed))
        return jsonify(_presence_body())

    @app.route("/api/presence/stream")
    def api_presence_stream():
        def gen():
            yield "retry: 3000\n\n"
            last = None
            while True:
                eff = is_presence_active()
                cur = (PRESENCE["id"], eff)   # emit when the grace window expires too, not just on POSTs
                if cur != last:
                    last = cur
                    yield "data: " + json.dumps(_presence_body()) + "\n\n"
                else:
                    yield ": ka\n\n"
                time.sleep(0.25)
        return Response(gen(), mimetype="text/event-stream", headers={
            "Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})



def start(DATA):
    """Start the feed pollers (only the configured upstreams) and the auto-alert watcher."""
    pollers = [_poll_coral, _poll_gpu_series]
    if OLLAMA_INSTANCES:
        pollers.append(_poll_ollama)
    if FRIGATE:
        pollers.append(_poll_frigate)
    if EMBY_URL and EMBY_KEY:
        pollers.append(_poll_emby)
    for fn in pollers:
        threading.Thread(target=fn, daemon=True, name="showtime-" + fn.__name__).start()
    threading.Thread(target=_auto_alert, args=(DATA,), daemon=True, name="showtime-autoalert").start()
    print("[showtime] started (ollama x{}, frigate {}, emby {})".format(
        len(OLLAMA_INSTANCES), "yes" if FRIGATE else "no", "yes" if (EMBY_URL and EMBY_KEY) else "no"), flush=True)
