#!/usr/bin/env python3
"""Drive room lights 1:1 from the galaxy dashboard's real screen.

lightsync.js runs in the browser actually displaying the dashboard, samples its
own WebGL canvas and POSTs the current galaxy colour to /api/lightstate (and the
per-screen colour to /api/lightcolor). This daemon reads those and drives:

  * a Govee LAN-API bulb/strip (UDP, ~20 ms) -- GOVEE_IP
  * one or more Philips Hue lights straight through the bridge (HTTPS PUT,
    ~150 ms; Zigbee-limited to one write per ~8 s) -- HUE_BRIDGE + HUE_KEY_FILE

Either light may be left unconfigured. Everything is environment-driven:

    DASHBOARD_URL=http://10.0.0.51:8080     # the dashboard
    DASH_API_KEY=                           # only if the dashboard has a key set
    GOVEE_IP=10.0.0.105                     # Govee LAN control must be enabled in the app
    HUE_BRIDGE=10.0.0.171
    HUE_KEY_FILE=/etc/galaxy-lights/hue-key # chmod 600; create with hue-pair (press the link button)
    HUE_LIGHTS=1,4                          # bridge light ids, comma separated
    VIDEO_BRI=0.78                          # camera-facing ceiling for brightness (0..1)

Behaviour (the "envelope"):

  tour    hold BRI_HOLD at a stop, dip to BRI_TRAVEL while the camera flies, punch
          to BRI_PUNCH for BRI_PUNCH_S when it lands (a `beat` change), and snap
          the hue on the beat instead of slewing 150 deg through a 3.8 s dwell.
  doom /  a red 2 Hz pulse between DOOM_LO and DOOM_HI. Deliberately not a hard
  threat  strobe: high-contrast flashing above ~3 Hz is a photosensitivity risk.
          `threat` is what the wall publishes for ~2.5 s when /api/threats
          reports a NEW intrusion; the tour then resumes.

The Govee follows the second screen's colour (/api/lightcolor src=nexus) and the
Hue follows the wall's; in doom/threat both go red together. /api/lightenable
is the home-automation intent: while it is false nothing is written, because a
colour frame would wake an off bulb. The bulb's own power button is respected
the same way: an off bulb is never dragged back on.

Run:  galaxy-lights.py run | selftest
"""
import argparse
import colorsys
import json
import math
import os
import socket
import ssl
import time
import urllib.request

DASHBOARD = os.environ.get("DASHBOARD_URL", "http://127.0.0.1:8080").rstrip("/")
DASH = DASHBOARD + "/api/lightstate"
LIGHTCOLOR = DASHBOARD + "/api/lightcolor"
LIGHTENABLE = DASHBOARD + "/api/lightenable"
# The dashboard's optional shared key (auth.py). Unset on a dashboard that has
# no gate, which is the default; sent on every read when it is set.
DASH_HEADERS = ({"X-API-Key": os.environ["DASH_API_KEY"].strip()}
                if os.environ.get("DASH_API_KEY", "").strip() else {})
VIDEO_BRI = float(os.environ.get("VIDEO_BRI", "0.78"))
COLOR_STALE = 12.0          # a screen quiet this long falls back to the tour colour
GOVEE_IP = os.environ.get("GOVEE_IP", "").strip()
GOVEE_CTRL = 4003
BRIDGE = os.environ.get("HUE_BRIDGE", "").strip()
KEYFILE = os.environ.get("HUE_KEY_FILE", "/etc/galaxy-lights/hue-key")
HUE_LIGHTS = [x.strip() for x in os.environ.get("HUE_LIGHTS", "1").split(",") if x.strip()]

POLL = 0.10                 # the brightness envelope needs fine steps
SLEW_DEG_S = 70.0           # max hue movement per second while drifting within a stop
SEND_DEG = 2.0              # only push when the smoothed hue moved this much
STALE_AFTER = 45.0          # no browser publishing for this long -> do nothing
TRANSITION = 2              # Hue transitiontime, deciseconds

# ---- brightness envelope -------------------------------------------------
BRI_HOLD = 85               # parked at a tour stop: the resting level
BRI_TRAVEL = 45             # camera in transit: a real dip, so the arrival lands
BRI_PUNCH = 100             # the arrival itself
BRI_PUNCH_S = 0.28          # ...held this long, or it is over before it is seen
BRI_SLEW = 150.0            # points per second the envelope may move
BRI_SEND = 3                # only push when it moved this much

DOOM_HZ = 2.0
DOOM_LO = 55
DOOM_HI = 100
DOOM_HUE = 0.0              # red

_ctx = ssl.create_default_context()
_ctx.check_hostname = False
_ctx.verify_mode = ssl.CERT_NONE


class Govee:
    def __init__(self, ip):
        self.ip = ip
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.s.bind(("0.0.0.0", 4002))

    def send(self, cmd, data):
        self.s.sendto(json.dumps({"msg": {"cmd": cmd, "data": data}}).encode(), (self.ip, GOVEE_CTRL))

    def status(self, timeout=1.5):
        self.send("devStatus", {})
        self.s.settimeout(timeout)
        try:
            return json.loads(self.s.recvfrom(4096)[0].decode())["msg"]["data"]
        except Exception:
            return None


def hue_key():
    try:
        with open(KEYFILE) as fh:
            return fh.read().strip()
    except OSError:
        return None


def rgb_to_xy(r, g, b):
    r, g, b = [c / 255.0 for c in (r, g, b)]

    def f(c):
        return ((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92
    r, g, b = f(r), f(g), f(b)
    X = r * 0.4124 + g * 0.3576 + b * 0.1805
    Y = r * 0.2126 + g * 0.7152 + b * 0.0722
    Z = r * 0.0193 + g * 0.1192 + b * 0.9505
    s = X + Y + Z
    if s == 0:
        return [0.3127, 0.3290]
    return [round(X / s, 4), round(Y / s, 4)]


def set_hue(key, rgb, on=False):
    if not BRIDGE:
        return
    xy = rgb_to_xy(*rgb)
    payload = {"xy": xy, "bri": int(round(254 * VIDEO_BRI)), "transitiontime": TRANSITION}
    if on:                      # only ever sent when explicitly turning on
        payload["on"] = True
    body = json.dumps(payload).encode()
    for lid in HUE_LIGHTS:
        req = urllib.request.Request(f"https://{BRIDGE}/api/{key}/lights/{lid}/state", data=body, method="PUT")
        req.add_header("Content-Type", "application/json")
        try:
            urllib.request.urlopen(req, timeout=4, context=_ctx).read()
        except Exception:
            pass


def hue_of(rgb):
    h, _l, _s = colorsys.rgb_to_hls(rgb[0] / 255.0, rgb[1] / 255.0, rgb[2] / 255.0)
    return h * 360.0


def rgb_of(hue):
    r, g, b = colorsys.hls_to_rgb((hue % 360.0) / 360.0, 0.52, 0.95)
    return [int(r * 255), int(g * 255), int(b * 255)]


def slew(cur, target, max_step):
    """Move cur toward target the short way round the colour wheel."""
    d = (target - cur + 540.0) % 360.0 - 180.0
    if abs(d) <= max_step:
        return target % 360.0
    return (cur + max_step * (1 if d > 0 else -1)) % 360.0


def hue_is_on(key):
    if not BRIDGE:
        return None
    try:
        d = json.loads(urllib.request.urlopen(f"https://{BRIDGE}/api/{key}/lights/{HUE_LIGHTS[0]}",
                                              timeout=3, context=_ctx).read())
        return bool(d["state"]["on"])
    except Exception:
        return None


def _get_json(url, timeout):
    req = urllib.request.Request(url, headers=DASH_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def lightstate():
    try:
        return _get_json(DASH, 3)
    except Exception:
        return None


_le_cache = {"t": 0.0, "v": True}


def light_enabled(now):
    """Is the room allowed to be lit at all? Owned by the home automation.
    Fails OPEN: if the dashboard is unreachable keep the last known answer."""
    if now - _le_cache["t"] < 0.3:
        return _le_cache["v"]
    try:
        _le_cache["v"] = bool(_get_json(LIGHTENABLE, 2).get("enabled", True))
    except Exception:
        pass
    _le_cache["t"] = now
    return _le_cache["v"]


_lc_cache = {"t": 0.0, "v": {}}


def lightcolors(now):
    """Per-screen sampled colours, cached briefly."""
    if now - _lc_cache["t"] < 0.4:
        return _lc_cache["v"]
    try:
        _lc_cache["v"] = _get_json(LIGHTCOLOR, 2)
    except Exception:
        pass                      # keep the last good value rather than going dark
    _lc_cache["t"] = now
    return _lc_cache["v"]


def _src_rgb(lc, name, now, fallback):
    e = lc.get(name) if isinstance(lc, dict) else None
    if not e:
        return fallback
    rgb, ts = e.get("rgb"), e.get("ts", 0)
    if not (isinstance(rgb, list) and len(rgb) == 3):
        return fallback
    if now - ts > COLOR_STALE:
        return fallback
    return rgb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["run", "selftest"], nargs="?", default="run")
    a = ap.parse_args()

    g = Govee(GOVEE_IP) if GOVEE_IP else None
    key = hue_key() if BRIDGE else None

    if a.mode == "selftest":
        st = lightstate()
        age = (time.time() - st["ts"]) if (st and st.get("ts")) else None
        print("dashboard       :", DASHBOARD)
        print("lightstate      :", st)
        print("age (s)         :", round(age, 1) if age is not None else "never published")
        print("stale?          :", "YES - no browser publishing" if (age is None or age > STALE_AFTER) else "no")
        print("govee           :", ("reachable" if g.status() else "NO ANSWER") if g else "not configured")
        print("hue bridge      :", BRIDGE or "not configured")
        print("hue key         :", "present" if key else ("MISSING - pair the bridge" if BRIDGE else "n/a"))
        if key:
            t0 = time.time()
            set_hue(key, [0, 200, 255])
            print("hue write (ms)  :", int((time.time() - t0) * 1000))
        return 0

    if not g and not key:
        raise SystemExit("nothing to drive: set GOVEE_IP and/or HUE_BRIDGE + HUE_KEY_FILE")

    cur_hue = None
    last_sent_hue = None
    powered = False
    next_power = 0.0
    next_hue_chk = 0.0
    next_hue_write = 0.0
    cur_bri = float(BRI_HOLD)
    sent_bri = None
    last_sent_gv = None
    last_beat = None
    punch_until = 0.0
    snap_hue = False
    cur_hue_gv = None          # Govee channel, driven by the second screen
    prev_t = time.time()
    next_pow_probe = 0.0

    while True:
        now = time.time()
        # Easing is driven by REAL elapsed time, not by the poll constant: every
        # send does a blocking UDP status probe, so the loop does not run at 1/POLL.
        dt = min(0.5, max(0.001, now - prev_t))
        prev_t = now

        if now >= next_power:
            if g:
                st0 = g.status()
                if st0 is not None:
                    was, powered = powered, bool(st0.get("onOff"))
                    if powered and not was:
                        cur_hue = None
                        last_sent_hue = None
            else:
                h_on = hue_is_on(key)
                powered = True if h_on is None else h_on
            next_power = now + 1.0

        st = lightstate()
        fresh = bool(st and st.get("ts") and (now - st["ts"] <= STALE_AFTER))

        # the Hue owns its own on/off: if the button turned it off, stop
        # writing entirely rather than dragging it back on
        if powered and key and now >= next_hue_chk:
            h_on = hue_is_on(key)
            next_hue_chk = now + 1.0
            if h_on is False:
                powered = False

        # Intent gate: while the automation says the room is off, write NOTHING
        enabled = light_enabled(now)
        if not enabled:
            powered = False

        if powered and fresh and enabled:
            mode = st.get("mode", "tour")
            phase = st.get("phase", "hold")
            beat = st.get("beat")

            # ---- brightness envelope --------------------------------------
            alarm = mode in ("doom", "threat")
            if alarm:
                osc = 0.5 - 0.5 * math.cos(now * DOOM_HZ * 2.0 * math.pi)   # free-running pulse; no easing
                cur_bri = DOOM_LO + (DOOM_HI - DOOM_LO) * osc
            else:
                if beat is not None and beat != last_beat:
                    if last_beat is not None:
                        punch_until = now + BRI_PUNCH_S   # the camera landed
                        snap_hue = True                   # ...and so does the colour
                    last_beat = beat
                if now < punch_until:
                    cur_bri = float(BRI_PUNCH)
                else:
                    tgt = BRI_TRAVEL if phase == "travel" else BRI_HOLD
                    step = BRI_SLEW * dt
                    if cur_bri < tgt:
                        cur_bri = min(tgt, cur_bri + step)
                    elif cur_bri > tgt:
                        cur_bri = max(tgt, cur_bri - step)

            rgb = st.get("rgb")
            if alarm:
                rgb = rgb_of(DOOM_HUE)               # the room goes red with it
            lc = lightcolors(now)
            wall_rgb = _src_rgb(lc, "wall", now, rgb)
            nexus_rgb = _src_rgb(lc, "nexus", now, rgb)
            if isinstance(rgb, list) and len(rgb) == 3:
                rgb = wall_rgb if isinstance(wall_rgb, list) else rgb
                target = DOOM_HUE if alarm else hue_of(rgb)
                target_gv = (DOOM_HUE if alarm else hue_of(nexus_rgb if isinstance(nexus_rgb, list) else rgb))
                if cur_hue_gv is None or alarm or snap_hue:
                    cur_hue_gv = target_gv
                else:
                    cur_hue_gv = slew(cur_hue_gv, target_gv, SLEW_DEG_S * dt)
                # An arrival is a cut, not a dissolve: snap on the beat, slew for drift within a stop.
                if cur_hue is None or alarm or snap_hue:
                    cur_hue = target
                    snap_hue = False
                else:
                    cur_hue = slew(cur_hue, target, SLEW_DEG_S * dt)

                moved = (last_sent_hue is None
                         or abs((cur_hue - last_sent_hue + 540.0) % 360.0 - 180.0) >= SEND_DEG
                         or (cur_hue_gv is not None and last_sent_gv is not None
                             and abs((cur_hue_gv - last_sent_gv + 540.0) % 360.0 - 180.0) >= SEND_DEG)
                         or last_sent_gv is None)
                bri_moved = (sent_bri is None or abs(cur_bri - sent_bri) >= BRI_SEND)
                if moved or bri_moved:
                    # Govee colour/brightness frames WAKE an off bulb and the cached
                    # power flag can be a second stale: re-check right before writing.
                    if g and now >= next_pow_probe:
                        next_pow_probe = now + 0.5
                        st_now = g.status(timeout=0.35)
                        if st_now is not None and not st_now.get("onOff"):
                            powered = False
                            time.sleep(POLL)
                            continue
                    out = rgb_of(cur_hue)                 # wall  -> Hue
                    out_gv = rgb_of(cur_hue_gv if cur_hue_gv is not None else cur_hue)
                    if moved:
                        if g:
                            g.send("colorwc", {"color": {"r": out_gv[0], "g": out_gv[1], "b": out_gv[2]},
                                               "colorTemInKelvin": 0})
                        if key and now >= next_hue_write:
                            set_hue(key, out)
                            next_hue_write = now + 8.0
                        last_sent_hue = cur_hue
                        last_sent_gv = cur_hue_gv
                    if bri_moved:
                        if g:
                            g.send("brightness", {"value": int(round(cur_bri * VIDEO_BRI))})
                        sent_bri = cur_bri

        time.sleep(POLL)


if __name__ == "__main__":
    raise SystemExit(main())
