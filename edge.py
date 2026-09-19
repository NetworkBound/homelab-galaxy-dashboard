"""edge.py - the estate's OUTSIDE connections.

Three background pollers, each in its own daemon thread, each optional (skipped
when its URL is unset) and each degrading to ``{"up": false, ...}`` on failure
without touching the others or the request path:

  DATA["edge"]["cloudflare"]  a cloudflared tunnel's Prometheus text endpoint
                              (``cloudflared tunnel run --metrics 0.0.0.0:20241``
                              or the ``metrics:`` key in its config). Counters
                              are differenced HERE into per-minute rates.
                              Config: CLOUDFLARED_METRICS_URL.
  DATA["edge"]["crowdsec"]    CrowdSec alerts with country/AS. Geo only exists
                              in cscli output, so a cron on the CrowdSec host
                              writes ``cscli alerts list -o json`` and
                              ``cscli decisions list -o json`` to a directory
                              nginx serves read-only (deploy/edge/).
                              Config: CROWDSEC_EXPORT_URL (base of alerts.json).
  DATA["external"]            Akvorado's console HTTP API
                              (POST /api/v0/console/graph/line) over the last
                              hour: top external destinations / sources with
                              country + ASN, per-country in/out, internal
                              talkers, totals. Sampling is already corrected
                              by the console. ``flows`` per row is null on this
                              path: the console has no flow-count unit.
                              Config: AKVORADO_URL.

``geo(ip)`` exposes the ip -> {cc, asn, as_name} map learned from Akvorado so
topology.py can enrich ntopng flows on their external endpoint.

Imported by app.py; call ``start_edge(DATA)``.
"""
import ipaddress
import re
import threading
import time
from datetime import datetime, timezone

import requests

import config

CF_URL = config.CLOUDFLARED_METRICS_URL
CS_URL = config.CROWDSEC_EXPORT_URL
AKV_URL = config.AKVORADO_URL

CF_S, CS_S, AKV_S = 30, 60, 60      # poll intervals (seconds)
WINDOW_S = 3600                     # Akvorado look-back
RATE_SPAN = 120                     # cloudflared rates: delta over up to this many seconds
TOP_N = 12
GEO_N = 50                          # rows fetched per Akvorado query (console max is 50; the rest feeds geo())

DATA = None
_geo = {}                           # ip -> {"cc","asn","as_name"}
_cf_hist = []                       # [(ts, total_requests, request_errors)]

# ---------------- helpers ----------------
_PROM_RE = re.compile(r'^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+([-+0-9.eE]+|NaN|[+-]Inf)\s*$')
_LBL_RE = re.compile(r'([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"')


def _parse_prom(text):
    """Prometheus text exposition -> list of (name, {labels}, float)."""
    out = []
    for line in text.splitlines():
        if not line or line[0] == '#':
            continue
        m = _PROM_RE.match(line)
        if not m:
            continue
        name, lbl, val = m.groups()
        labels = dict(_LBL_RE.findall(lbl[1:-1])) if lbl else {}
        try:
            v = float(val)
        except ValueError:
            continue
        out.append((name, labels, v))
    return out


def _strip6(ip):
    ip = str(ip or "")
    return ip[7:] if ip.startswith("::ffff:") else ip


def _is_ip(s):
    try:
        ipaddress.ip_address(s); return True
    except ValueError:
        return False


def _parse_as(s):
    """'64500: Example Networks' -> (64500, 'Example Networks'); '' -> (None, None)."""
    s = str(s or "")
    if not s or s == "Other":
        return None, None
    n, _, name = s.partition(":")
    try:
        return int(n.strip()), (name.strip() or None)
    except ValueError:
        return None, s or None


def _iso_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def geo(ip):
    """ip -> {"cc","asn","as_name"} learned from Akvorado, or None."""
    return _geo.get(_strip6(ip))


# ---------------- cloudflared ----------------
def _cloudflare_once(now):
    r = requests.get(CF_URL, timeout=5)
    r.raise_for_status()
    rows = _parse_prom(r.text)
    ha = total = errs = None
    by_code, locs, buckets = {}, set(), {}
    conc = tcp = 0.0
    for name, lb, v in rows:
        if name == "cloudflared_tunnel_ha_connections":         ha = int(v)
        elif name == "cloudflared_tunnel_total_requests":       total = (total or 0) + v
        elif name == "cloudflared_tunnel_request_errors":       errs = (errs or 0) + v
        elif name == "cloudflared_tunnel_response_by_code":
            by_code[lb.get("status_code", "?")] = by_code.get(lb.get("status_code", "?"), 0) + int(v)
        elif name == "cloudflared_tunnel_server_locations" and v >= 1:
            locs.add(lb.get("edge_location", "?"))
        elif name == "cloudflared_tunnel_concurrent_requests_per_tunnel": conc += v
        elif name == "cloudflared_tcp_active_sessions":         tcp += v
        elif name == "cloudflared_proxy_connect_latency_bucket":
            le = lb.get("le", "+Inf")
            buckets[le] = buckets.get(le, 0.0) + v

    # rates: real deltas of the cumulative counters over the last <= RATE_SPAN s
    req_pm = err_pm = None
    if total is not None:
        _cf_hist.append((now, total, errs or 0.0))
        while len(_cf_hist) > 1 and now - _cf_hist[0][0] > RATE_SPAN:
            _cf_hist.pop(0)
        t0, r0, e0 = _cf_hist[0]
        dt = now - t0
        if dt >= 10 and total >= r0:           # counter reset -> skip this delta
            req_pm = round((total - r0) / dt * 60.0, 2)
            err_pm = round(((errs or 0.0) - e0) / dt * 60.0, 2)

    # p50 from the histogram (linear interpolation within the bucket)
    p50 = None
    try:
        edges = sorted(((float(k) if k != "+Inf" else float("inf")), c) for k, c in buckets.items())
        n = edges[-1][1] if edges else 0
        if n > 0:
            half, prev_le, prev_c = n / 2.0, 0.0, 0.0
            for le, c in edges:
                if c >= half:
                    if le == float("inf"):
                        p50 = prev_le
                    else:
                        frac = (half - prev_c) / max(c - prev_c, 1e-9)
                        p50 = round(prev_le + (le - prev_le) * frac, 1)
                    break
                prev_le, prev_c = le, c
    except Exception:
        p50 = None

    return {"up": True, "ts": now,
            "ha_connections": ha,
            "total_requests": int(total) if total is not None else None,
            "request_errors": int(errs) if errs is not None else None,
            "req_per_min": req_pm, "err_per_min": err_pm,
            "by_code": by_code,
            "locations": sorted(locs),
            "connect_latency_ms_p50": p50,
            "active_streams": int(conc),
            "tcp_sessions": int(tcp)}


def poll_cloudflare():
    while True:
        now = time.time()
        try:
            DATA["edge"]["cloudflare"] = _cloudflare_once(now)
        except Exception as e:
            old = DATA["edge"].get("cloudflare") or {}
            DATA["edge"]["cloudflare"] = {**old, "up": False, "ts": now, "error": str(e)[:120]}
            print("[edge] cloudflare:", str(e)[:120], flush=True)
        time.sleep(CF_S)


# ---------------- crowdsec ----------------
def _crowdsec_once(now):
    alerts = requests.get(f"{CS_URL}/alerts.json", timeout=5).json() or []
    try:
        decisions = requests.get(f"{CS_URL}/decisions.json", timeout=5).json() or []
    except Exception:
        decisions = None
    rows = []
    for a in alerts:
        src = a.get("source") or {}
        ts = _iso_ts(a.get("created_at")) or _iso_ts(a.get("start_at"))
        rows.append({"ip": src.get("ip") or src.get("value"),
                     "cn": src.get("cn") or None,
                     "as_name": src.get("as_name") or None,
                     "as_number": src.get("as_number") or None,
                     "scenario": a.get("scenario"),
                     "events": a.get("events_count"),
                     "ts": round(ts) if ts else None})
    rows.sort(key=lambda r: -(r["ts"] or 0))
    alerts_1h = sum(1 for r in rows if r["ts"] and now - r["ts"] <= 3600)
    by_cn = {}
    for r in rows:
        k = r["cn"] or "??"
        by_cn[k] = by_cn.get(k, 0) + 1
    tele = (DATA.get("telemetry") or {}) if isinstance(DATA.get("telemetry"), dict) else {}
    if decisions is not None:
        banned = sum(len(a.get("decisions") or []) for a in decisions)
    else:
        banned = tele.get("cs_banned")
    return {"up": True, "ts": now,
            "alerts_1h": alerts_1h,
            "alerts_24h": len(rows),
            "banned": banned,
            "lines_per_min": tele.get("cs_lines_m"),     # rate(cs_parser_hits_ok_total) via Prometheus
            "top_attackers": rows[:TOP_N],
            "by_country": dict(sorted(by_cn.items(), key=lambda kv: -kv[1]))}


def poll_crowdsec():
    while True:
        now = time.time()
        try:
            DATA["edge"]["crowdsec"] = _crowdsec_once(now)
        except Exception as e:
            old = DATA["edge"].get("crowdsec") or {}
            DATA["edge"]["crowdsec"] = {**old, "up": False, "ts": now, "error": str(e)[:120]}
            print("[edge] crowdsec:", str(e)[:120], flush=True)
        time.sleep(CS_S)


# ---------------- akvorado ----------------
def _akv_line(start, end, dims, filt, limit):
    body = {"start": start, "end": end, "points": 6, "dimensions": dims,
            "limit": limit, "filter": filt, "units": "l3bps"}
    r = requests.post(f"{AKV_URL}/api/v0/console/graph/line", json=body, timeout=20)
    r.raise_for_status()
    d = r.json()
    rows, avg, tot = d.get("rows") or [], d.get("average") or [], d.get("total") or []
    out, other = [], None
    for i, row in enumerate(rows):
        a = float(avg[i]) if i < len(avg) else 0.0
        b = int(tot[i]) if i < len(tot) else 0
        if row and row[0] == "Other":
            other = (a, b)
            continue
        out.append((row, a, b))
    return out, other


def _node_by_ip():
    m = {}
    t = DATA.get("topology") if isinstance(DATA.get("topology"), dict) else None
    for n in (t or {}).get("nodes") or []:
        ip = n.get("ip")
        if ip and (ip not in m or str(m[ip]).startswith("disc:")):
            m[str(ip)] = n.get("id")
    return m


def _external_once(now):
    end = datetime.fromtimestamp(now, timezone.utc)
    start = datetime.fromtimestamp(now - WINDOW_S, timezone.utc)
    S, E = start.strftime("%Y-%m-%dT%H:%M:%SZ"), end.strftime("%Y-%m-%dT%H:%M:%SZ")
    geo_new = {}

    def endpoints(dims, filt):
        rows, other = _akv_line(S, E, dims, filt, GEO_N)
        out = []
        for (addr, cc, asn_s), a, b in rows:
            ip = _strip6(addr)
            asn, as_name = _parse_as(asn_s)
            cc = cc if cc and cc != "Other" else None
            if _is_ip(ip):
                geo_new[ip] = {"cc": cc, "asn": asn, "as_name": as_name}
            out.append({"ip": ip, "cc": cc, "asn": asn, "as_name": as_name,
                        "bps": round(a, 1), "bytes": b, "flows": None})
        total = sum(r["bps"] for r in out) + (other[0] if other else 0.0)
        return out, total

    top_dst, tot_out = endpoints(["DstAddr", "DstCountry", "DstAS"], "OutIfBoundary = external")
    top_src, tot_in = endpoints(["SrcAddr", "SrcCountry", "SrcAS"], "InIfBoundary = external")

    cc_rows = {}
    rows, other = _akv_line(S, E, ["DstCountry"], "OutIfBoundary = external", 24)
    for (cc,), a, b in rows:
        e = cc_rows.setdefault(cc or "??", {"cc": cc or "??", "bps_out": 0.0, "bps_in": 0.0, "bytes": 0})
        e["bps_out"] += a; e["bytes"] += b
    rows, other = _akv_line(S, E, ["SrcCountry"], "InIfBoundary = external", 24)
    for (cc,), a, b in rows:
        e = cc_rows.setdefault(cc or "??", {"cc": cc or "??", "bps_out": 0.0, "bps_in": 0.0, "bytes": 0})
        e["bps_in"] += a; e["bytes"] += b
    by_country = sorted(cc_rows.values(), key=lambda e: -e["bytes"])
    for e in by_country:
        e["bps_out"] = round(e["bps_out"], 1); e["bps_in"] = round(e["bps_in"], 1)

    nodes = _node_by_ip()
    rows, other = _akv_line(S, E, ["SrcAddr"], "OutIfBoundary = external", 10)
    talkers = []
    for (addr,), a, b in rows:
        ip = _strip6(addr)
        talkers.append({"ip": ip, "node": nodes.get(ip), "bps_out": round(a, 1), "bytes": b})

    # atomic-ish swap of the geo map (dict replace, never partial)
    global _geo
    _geo = geo_new

    return {"up": True, "ts": now, "window_s": WINDOW_S,
            "top_dst": top_dst[:TOP_N], "top_src": top_src[:TOP_N],
            "by_country": by_country, "talkers": talkers,
            "total_bps_out": round(tot_out, 1), "total_bps_in": round(tot_in, 1)}


def poll_external():
    while True:
        now = time.time()
        try:
            DATA["external"] = _external_once(now)
        except Exception as e:
            old = DATA.get("external") if isinstance(DATA.get("external"), dict) else {}
            DATA["external"] = {**(old or {}), "up": False, "ts": now, "error": str(e)[:120]}
            print("[edge] akvorado:", str(e)[:120], flush=True)
        time.sleep(AKV_S)


# ---------------- entry ----------------
def start_edge(data=None):
    """Start whichever of the three pollers is configured. Unconfigured blocks
    stay ``{"up": false, "error": "not configured"}`` so the screens degrade per block."""
    global DATA
    if data is not None:
        DATA = data
    if DATA is None:
        DATA = {}
    DATA.setdefault("edge", {})
    DATA["edge"].setdefault("cloudflare", {"up": False, "ts": 0, "error": "not polled yet" if CF_URL else "not configured"})
    DATA["edge"].setdefault("crowdsec", {"up": False, "ts": 0, "error": "not polled yet" if CS_URL else "not configured"})
    DATA.setdefault("external", {"up": False, "ts": 0, "error": "not polled yet" if AKV_URL else "not configured"})
    started = []
    for url, fn in ((CF_URL, poll_cloudflare), (CS_URL, poll_crowdsec), (AKV_URL, poll_external)):
        if url:
            threading.Thread(target=fn, daemon=True, name="edge-" + fn.__name__).start()
            started.append(fn.__name__)
    return started
