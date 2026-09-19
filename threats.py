"""threats.py - one SECURITY + AUDIENCE feed for both screens.

Three background pollers (daemon threads, each optional, each degrading to
{"up": false} on failure) and two routes. Everything lands under DATA["edge"] so
/api/all and /api/topology (which mirrors DATA["edge"] wholesale) carry it with
no other change:

  DATA["edge"]["secmon"]     a Security Monitor with a findings API:
                             /api/stats/summary + /api/findings -> threat level
                             GREEN/YELLOW/RED/BLACK, active counts by severity,
                             the newest unacknowledged findings (title, category,
                             severity, hosts, ts). Config: SECMON_URL, SECMON_TZ.
  DATA["edge"]["audience"]   REAL viewers: unique visitor IPs + requests over the
                             last 5 min and 1 h, top countries, top hostnames.
                             Source A (preferred, needs CF_API_TOKEN with
                             Analytics:Read + CF_ZONE_ID): Cloudflare GraphQL.
                             Source B (AUDIENCE_URL): audience.json written on
                             the origin from its nginx log by
                             deploy/edge/galaxy-audience-export.py. Both mark
                             `source`; monitors/bots are never counted as viewers.
  DATA["edge"]["threats"]    the unified, de-duplicated timeline the screens and
                             the room lights react to: CrowdSec alerts (from
                             edge.py's crowdsec block) + Security Monitor
                             findings, newest first, with a monotonic `seq`
                             that only advances on a NEW event after boot.

  GET /api/threats           the block above
  GET /api/threats/stream    SSE: one frame per seq change (+15 s keepalive),
                             same idiom as /api/lightstate/stream. Both screens
                             subscribe; the wall also flips the room lights to
                             mode "threat" for a couple of seconds.

Nothing here is decorative: every event has a real source id and timestamp.
"""
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests
from flask import Response, jsonify

import config

SECMON_URL = config.SECMON_URL
CF_TOKEN = config.CF_API_TOKEN
CF_ZONE = config.CF_ZONE_ID
AUD_URL = config.AUDIENCE_URL
CF_GQL = "https://api.cloudflare.com/client/v4/graphql"
SECMON_S, CF_S, UNIFY_S = 45, 60, 5
KEEP = 40                     # events kept on the timeline

try:
    _TZ = ZoneInfo(config.SECMON_TZ or "UTC")
except Exception:
    _TZ = timezone.utc

DATA = None
_lock = threading.Lock()
_cond = threading.Condition(_lock)
_state = {"up": False, "seq": 0, "ts": 0, "level": 0, "name": "GREEN", "counts": {}, "events": [], "latest": None}
_seen = set()
_booted = False

SEV = {"CRITICAL": 4, "HIGH": 3, "MEDIUM": 2, "LOW": 1}
LEVEL_NAME = {0: "GREEN", 1: "YELLOW", 2: "RED", 3: "BLACK"}


def _edge():
    if DATA is None:
        return {}
    e = DATA.get("edge")
    if not isinstance(e, dict):
        e = {}
        DATA["edge"] = e
    return e


def _local_ts(s):
    """'2026-09-18 18:01:42' (naive, in SECMON_TZ) or an ISO string -> epoch."""
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=_TZ)
    return d.timestamp()


# ---------------- Security Monitor ----------------
def _secmon_once(now):
    s = requests.get(f"{SECMON_URL}/api/stats/summary", timeout=6).json()
    f = requests.get(f"{SECMON_URL}/api/findings", params={"limit": 25}, timeout=8).json()
    rows = []
    for x in (f if isinstance(f, list) else (f.get("findings") or f.get("items") or [])):
        if x.get("acknowledged") or x.get("false_positive"):
            continue
        ts = _local_ts(x.get("found_at"))
        if ts and now - ts > 7 * 86400:
            continue
        rows.append({"id": x.get("id"), "ts": round(ts) if ts else None,
                     "severity": str(x.get("severity") or "").upper(),
                     "sev": SEV.get(str(x.get("severity") or "").upper(), 1),
                     "category": x.get("category"), "title": (x.get("title") or "")[:96],
                     "hosts": list(x.get("affected_hosts") or [])[:4]})
    rows.sort(key=lambda r: -(r["ts"] or 0))
    return {"up": True, "ts": now,
            "threat_level": int(s.get("threat_level") or 0),
            "threat_name": str(s.get("threat_name") or LEVEL_NAME.get(int(s.get("threat_level") or 0), "GREEN")),
            "active": (s.get("findings") or {}).get("active") or {},
            "last_24h": (s.get("findings") or {}).get("last_24h") or {},
            "events_per_hour": s.get("events_per_hour"),
            "blocked_ips_24h": s.get("blocked_ips_24h"),
            "findings": rows[:12]}


def poll_secmon():
    while True:
        now = time.time()
        try:
            _edge()["secmon"] = _secmon_once(now)
        except Exception as e:
            old = _edge().get("secmon") or {}
            _edge()["secmon"] = {**old, "up": False, "ts": now, "error": str(e)[:120]}
            print("[threats] secmon:", str(e)[:120], flush=True)
        time.sleep(SECMON_S)


# ---------------- Cloudflare zone analytics (real viewers) ----------------
_GQL = """
query($zone: String!, $s5: String!, $s60: String!, $until: String!) {
  viewer { zones(filter: {zoneTag: $zone}) {
    t5:  httpRequestsAdaptiveGroups(limit: 1,  filter: {datetime_geq: $s5,  datetime_lt: $until}) { count uniq { uniques } }
    t60: httpRequestsAdaptiveGroups(limit: 1,  filter: {datetime_geq: $s60, datetime_lt: $until}) { count uniq { uniques } }
    cc:  httpRequestsAdaptiveGroups(limit: 12, filter: {datetime_geq: $s60, datetime_lt: $until}, orderBy: [count_DESC]) { count uniq { uniques } dimensions { clientCountryName } }
    host: httpRequestsAdaptiveGroups(limit: 8, filter: {datetime_geq: $s60, datetime_lt: $until}, orderBy: [count_DESC]) { count uniq { uniques } dimensions { clientRequestHTTPHost } }
  } }
}"""


def cf_query(token, zone, now=None):
    """One GraphQL round trip; shared with the setup wizard's connection test."""
    now = now or time.time()
    until = datetime.fromtimestamp(now, timezone.utc).replace(microsecond=0)
    v = {"zone": zone, "until": until.isoformat().replace("+00:00", "Z"),
         "s5": (until - timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
         "s60": (until - timedelta(minutes=60)).isoformat().replace("+00:00", "Z")}
    r = requests.post(CF_GQL, json={"query": _GQL, "variables": v},
                      headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"}, timeout=12)
    r.raise_for_status()
    j = r.json()
    if j.get("errors"):
        raise RuntimeError(str(j["errors"][0].get("message"))[:100])
    z = ((j.get("data") or {}).get("viewer") or {}).get("zones") or []
    if not z:
        raise RuntimeError("zone not visible to this token")
    z = z[0]

    def tot(rows):
        rows = rows or []
        return (int(rows[0].get("count") or 0), int(((rows[0].get("uniq") or {}).get("uniques")) or 0)) if rows else (0, 0)
    r5, u5 = tot(z.get("t5")); r60, u60 = tot(z.get("t60"))
    cc = [{"cc": (x.get("dimensions") or {}).get("clientCountryName"), "requests": int(x.get("count") or 0),
           "uniques": int(((x.get("uniq") or {}).get("uniques")) or 0)} for x in (z.get("cc") or [])]
    hosts = [{"host": (x.get("dimensions") or {}).get("clientRequestHTTPHost"), "requests": int(x.get("count") or 0),
              "uniques": int(((x.get("uniq") or {}).get("uniques")) or 0)} for x in (z.get("host") or [])]
    return {"up": True, "ts": now, "source": "cloudflare-graphql",
            "viewers_5m": u5, "requests_5m": r5, "viewers_1h": u60, "requests_1h": r60,
            "by_country": cc, "by_host": hosts}


def _cf_once(now):
    return cf_query(CF_TOKEN, CF_ZONE, now)


# Origin-log audience: when no Cloudflare token with Analytics:Read is available,
# the REAL viewer count comes from the origin instead. nginx there logs
# CF-Connecting-IP + CF-IPCountry + host for every proxied request and a
# 1-minute cron (deploy/edge/galaxy-audience-export.py) writes audience.json.
# Same contract as the GraphQL path; monitors/bots are counted separately and
# never mixed into "viewers". GraphQL is preferred whenever it is configured.
def _origin_once(now):
    j = requests.get(AUD_URL, timeout=5).json()
    age = now - float(j.get("ts") or 0)
    if age > 300:
        raise RuntimeError(f"audience.json stale ({age:.0f}s)")
    j["up"] = True
    j["fetched"] = now
    j.setdefault("source", "origin-log")
    return j


def poll_audience():
    have_token = bool(CF_TOKEN and CF_ZONE)
    while True:
        now = time.time()
        try:
            if have_token:
                try:
                    _edge()["audience"] = _cf_once(now)
                except Exception as e:
                    if not AUD_URL:
                        raise
                    print("[threats] audience graphql:", str(e)[:120], "- falling back to the origin log", flush=True)
                    _edge()["audience"] = _origin_once(now)
            else:
                _edge()["audience"] = _origin_once(now)
        except Exception as e:
            old = _edge().get("audience") or {}
            _edge()["audience"] = {**old, "up": False, "ts": now, "error": str(e)[:120]}
            print("[threats] audience:", str(e)[:120], flush=True)
        time.sleep(CF_S if have_token else 30)


# ---------------- unified timeline ----------------
def _short_as(name, ip):
    s = str(name or "").strip()
    if not s:
        return ip or "?"
    return s if len(s) <= 22 else s[:21] + "…"


def _unify(now):
    global _booted
    e = _edge()
    cs = e.get("crowdsec") or {}
    sm = e.get("secmon") or {}
    ev = []
    if cs.get("up"):
        for a in cs.get("top_attackers") or []:
            if not a or not a.get("ts"):
                continue
            if now - a["ts"] > 86400:
                continue
            scen = str(a.get("scenario") or "").replace("crowdsecurity/", "")
            ev.append({"id": "cs:{}@{}".format(a.get("ip"), a.get("ts")), "src": "crowdsec", "ts": int(a["ts"]), "sev": 2,
                       "kind": "BLOCKED", "title": scen or "intrusion attempt", "cc": a.get("cn"),
                       "as_name": _short_as(a.get("as_name"), a.get("ip")), "events": a.get("events") or 1})
    if sm.get("up"):
        for f in sm.get("findings") or []:
            if not f.get("ts") or now - f["ts"] > 86400:
                continue
            ev.append({"id": "sm:{}".format(f.get("id")), "src": "secmon", "ts": int(f["ts"]), "sev": int(f.get("sev") or 1),
                       "kind": f.get("severity") or "FINDING", "title": f.get("title") or "", "cc": None,
                       "as_name": None, "hosts": f.get("hosts") or [], "category": f.get("category")})
    ev.sort(key=lambda r: -r["ts"])
    ev = ev[:KEEP]
    counts = {"crowdsec_1h": cs.get("alerts_1h") if cs.get("up") else None,
              "crowdsec_24h": cs.get("alerts_24h") if cs.get("up") else None,
              "banned": cs.get("banned") if cs.get("up") else None,
              "secmon_critical": ((sm.get("active") or {}).get("CRITICAL")) if sm.get("up") else None,
              "secmon_high": ((sm.get("active") or {}).get("HIGH")) if sm.get("up") else None}
    if sm.get("up"):
        level = max(0, min(3, int(sm.get("threat_level") or 0)))
    else:
        level = 1 if (cs.get("alerts_1h") or 0) > 0 else 0
    # "new" = unseen AND recent: the pollers fill in over the first seconds after boot,
    # so a backlog of hours-old events must never fire the stream (or the lights)
    new = [x for x in ev if x["id"] not in _seen and now - x["ts"] <= 600]
    for x in ev:
        _seen.add(x["id"])
    if len(_seen) > 4000:
        _seen.intersection_update({x["id"] for x in ev})
    with _cond:
        if _booted and new:
            _state["seq"] += 1
            _state["latest"] = new[0]
            _cond.notify_all()
        _booted = True
        _state.update({"up": bool(cs.get("up") or sm.get("up")), "ts": now, "level": level,
                       "name": LEVEL_NAME.get(level, "GREEN"), "counts": counts, "events": ev})
        e["threats"] = dict(_state)


def poll_unify():
    while True:
        try:
            _unify(time.time())
        except Exception as e:
            print("[threats] unify:", str(e)[:120], flush=True)
        time.sleep(UNIFY_S)


# ---------------- wiring ----------------
def start(data):
    """Start the configured pollers; the unifier always runs (CrowdSec alone is a valid feed)."""
    global DATA
    DATA = data
    e = _edge()
    e.setdefault("secmon", {"up": False, "ts": 0, "error": "not polled yet" if SECMON_URL else "not configured"})
    e.setdefault("audience", {"up": False, "ts": 0,
                              "error": "not polled yet" if (AUD_URL or (CF_TOKEN and CF_ZONE)) else "not configured"})
    e.setdefault("threats", dict(_state))
    fns = [poll_unify]
    if SECMON_URL:
        fns.append(poll_secmon)
    if AUD_URL or (CF_TOKEN and CF_ZONE):
        fns.append(poll_audience)
    for fn in fns:
        threading.Thread(target=fn, daemon=True, name="threats-" + fn.__name__).start()


def install(app):
    @app.route("/api/threats")
    def api_threats():
        with _lock:
            return jsonify(dict(_state))

    @app.route("/api/threats/stream")
    def api_threats_stream():
        def gen():
            yield "retry: 3000\n\n"
            last = None
            while True:
                with _cond:
                    _cond.wait_for(lambda: _state["seq"] != last, timeout=15)  # noqa: B023 - called at once
                    cur = _state["seq"]
                    body = dict(_state)
                if cur != last:
                    last = cur
                    yield "data: " + json.dumps(body) + "\n\n"
                else:
                    yield ": keepalive\n\n"
        return Response(gen(), mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"})
