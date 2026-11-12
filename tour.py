"""GET /api/tour: one source of truth for the wall's and the TV's "aspect" stops
(CONTRACTS.md section 9.1), plus the shared problem vocabulary (section 9.3).

Built only from what the dashboard already polls: DATA (the /api/all keys),
showtime.SHOW (ollama / emby / frigate events / gpu series) and the cached
/api/universe body (anchors, short names, lab and stopped flags). No new
external polling. Rebuilt at most every CACHE_S seconds.

Nothing site-specific lives here: anchors are found in the universe by class and
by well-known application names, the stop each aspect follows is derived from the
system its anchor sits in, and TOUR_ANCHORS / TOUR_ASPECTS (config.py) override
both.

Honesty rules:
  * a missing or stale feed is ABSENT, never 0. An aspect whose sources are all
    absent is still listed, with status "unknown" and the fact "Feed: unavailable".
  * colour is for status only: s is "ok" | "warn" | "crit" | "" (no status).
  * lab gear, synthetic demo hosts and stopped guests never make anything red.
  * no IPs, no customer names, no user names.
"""
import json
import re
import threading
import time

import config

V = 1
CACHE_S = 5.0
STORY_MAX = 48         # one line a phone can read inside the 9:16 crop of the wall
# never a slogan, a question, a "did you know", an IP: the same rule story.js applies on the wall
_STORY_BAD = re.compile(r"[?!]|did you know|orbit|galaxy|from orbit|now showing|\d+\.\d+\.\d+\.\d+", re.I)
_STORY_KINDS = ("status", "rate", "count", "age")
STALE_S = 600          # a feed with a ts older than this is treated as absent
SHOW_STALE_S = 120     # showtime pollers run every 3-15 s

SEV_RANK = {"crit": 3, "warn": 2, "ok": 1, "": 0}
UNAVAILABLE = {"k": "Feed", "v": "unavailable", "s": ""}

# key, name, default `after` stop, anchor candidates in order: exact body ids,
# ("label", system, regex), ("class", system, cls), ("cat", system, category), then
# a system. "@featured" stands for the featured node's system (UI_FEATURED_NODE, else
# the node with the most guests). TOUR_ANCHORS puts an operator's id in front.
ASPECTS = [
    ("asp:internet", "Internet", "wan",
     ["name:internet", ("class", "sys:core", "gateway"), "sys:core"]),
    ("asp:security", "Security", "wan",
     ["name:cloudflare", ("label", None, r"^(cloudflared|crowdsec)\b"), "sys:core"]),
    ("asp:web", "Websites", "wan",
     [("label", None, r"^(nginx|npm|traefik|caddy|haproxy|nginx[- ]proxy[- ]manager)\b"),
      ("label", None, r"^cloudflared$"), "name:cloudflare", "sys:core"]),
    ("asp:wifi", "Wi-Fi", "fabric",
     [("class", "sys:core", "ap"), ("class", None, "ap"), "sys:core"]),
    ("asp:storage", "Storage", "@host",
     [("label", None, r"^(pbs|proxmox[- ]backup)"), ("label", None, r"^(truenas|nas|backup)"),
      ("class", None, "storage"), "@featured"]),
    ("asp:power", "Power", "@host",
     [("class", "@featured", "pve_host"), ("class", None, "pve_host"), "@featured"]),
    ("asp:monitoring", "Monitoring", "@host",
     [("label", None, r"^zabbix$"), ("label", None, r"^(zabbix|grafana|prometheus|uptime[- ]?kuma)"),
      ("cat", None, "monitor"), "@featured"]),
    ("asp:ai", "AI", "@host",
     [("label", None, r"^ollama$"), ("label", None, r"^(ollama|vllm|localai|open[- ]?webui)"),
      ("cat", None, "ai"), "@featured"]),
    ("asp:cameras", "Cameras", "@host",
     [("label", None, r"^frigate$"), ("label", None, r"(frigate|nvr)"), ("class", None, "camera"), "@featured"]),
    ("asp:media", "Media", "@host",
     [("label", None, r"^(emby|jellyfin|plex)$"), ("label", None, r"(emby|jellyfin|plex)"),
      ("cat", None, "media"), "@featured"]),
]


# ------------------------------------------------------------------ helpers --
def _num(v):
    """float(v) for real numbers, None for absent / junk / bool."""
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _fmt(v, dec=0):
    f = _num(v)
    if f is None:
        return None
    if dec == 0:
        return f"{int(round(f)):,}"
    return "{:,.{d}f}".format(f, d=dec)


def _rate(mbps):
    f = _num(mbps)
    if f is None:
        return None
    return _fmt(f, 1 if f < 100 else 0)


def _fact(k, v, u=None, s=""):
    out = {"k": k, "v": str(v), "s": s}
    if u:
        out["u"] = u
    return out


# Advance widths of Inter 500 with tabular figures, 1/100 em, ASCII 32..126. The wall sets the
# line at 26 px in a 560 px box (what a phone's 9:16 crop of the screen keeps), so the rule is
# pixels as well as characters: 48 characters of this face run to ~660 px.
_ADV = (27, 30, 49, 64, 65, 99, 65, 31, 39, 39, 65, 65, 27, 65, 27, 37, 65, 65, 65, 65, 65, 65, 65, 65, 65, 65, 27,
        27, 65, 65, 65, 53, 98, 71, 66, 73, 72, 60, 59, 75, 74, 27, 58, 69, 57, 91, 76, 77, 64, 77, 65, 65, 65, 74,
        71, 100, 70, 70, 64, 39, 37, 39, 48, 46, 34, 57, 62, 58, 62, 59, 38, 62, 60, 25, 25, 56, 25, 89, 60, 60, 62,
        62, 39, 54, 34, 60, 57, 83, 56, 58, 56, 39, 35, 39, 65)
_ADV_X = {"\u00b7": 30, "\u2013": 50, "\u00b0": 46, "\u2026": 91}
STORY_FONT_PX = 26
STORY_PX = 556         # the 560 px box; the wall measures the real glyphs and skips a line that does not fit


def story_px(text):
    """Estimated width of a story line on the wall, CSS px."""
    return sum(_ADV[ord(c) - 32] if 32 <= ord(c) < 127 else _ADV_X.get(c, 65) for c in str(text)) * STORY_FONT_PX / 100.0


def story_ok(text):
    """The story-line rule: <= 48 chars and one line of the wall's box, no slogan /
    question / IP; a number is a measured fact, so every candidate but a plain status carries one."""
    t = " ".join(str(text or "").split())
    return bool(t) and len(t) <= STORY_MAX and story_px(t) <= STORY_PX and not _STORY_BAD.search(t)


def _story(text, kind="count", prio=2):
    """One story candidate {text, kind, prio} or None when the text breaks the rule."""
    if text is None or kind not in _STORY_KINDS:
        return None
    t = " ".join(str(text).split())
    if not story_ok(t) or (kind != "status" and not re.search(r"\d", t)):
        return None
    return {"text": t, "kind": kind, "prio": int(prio)}


_KIND_ORDER = {"status": 0, "rate": 1, "count": 2, "age": 3}


def _stories(cands, limit=3):
    """Dedupe, rank (status > rate > count > age, then prio), keep <= limit."""
    out, seen = [], set()
    for c in cands:
        if not c or c["text"] in seen:
            continue
        seen.add(c["text"])
        out.append(c)
    out.sort(key=lambda c: (_KIND_ORDER[c["kind"]], c["prio"]))
    return out[:limit]


def _fresh(d, now, max_age=STALE_S):
    """A feed dict that is present, not marked down, not an error stub, not stale."""
    if not isinstance(d, dict) or not d:
        return False
    if d.get("up") is False or (d.get("error") and len(d) <= 3):
        return False
    ts = _num(d.get("ts"))
    return not (ts and now - ts > max_age)


def _worst(facts):
    best = ""
    for f in facts:
        if SEV_RANK.get(f.get("s", ""), 0) > SEV_RANK[best]:
            best = f["s"]
    return best


def _plural(n, word, many=None):
    return "{} {}".format(_fmt(n), word if int(round(n)) == 1 else (many or word + "s"))


# The server may run in UTC while the screens hang somewhere else: TOUR_TZ (an IANA
# zone) sets the zone for clock times on screen; unset = the server's local time.
TOUR_TZ = config.TOUR_TZ or ""


def _local_hm(ts):
    if TOUR_TZ:
        try:
            from datetime import datetime
            from zoneinfo import ZoneInfo
            return datetime.fromtimestamp(ts, ZoneInfo(TOUR_TZ)).strftime("%H:%M")
        except Exception:
            pass
    return time.strftime("%H:%M", time.localtime(ts))


def _ago(sec):
    sec = max(0, sec)
    if sec < 90:
        return "just now"
    if sec < 3600:
        return f"{round(sec / 60)} min ago"
    if sec < 86400:
        h = sec / 3600
        return (f"{h:.1f} h ago") if h < 10 else f"{round(h)} h ago"
    return f"{round(sec / 86400)} d ago"


# ----------------------------------------------------------------- universe --
class Uni:
    """Read-only view of a /api/universe body (dict) or None."""

    def __init__(self, body):
        body = body if isinstance(body, dict) else {}
        self.known = bool(body.get("bodies") or body.get("systems"))
        self.bodies = {b.get("id"): b for b in (body.get("bodies") or []) if isinstance(b, dict) and b.get("id")}
        self.systems = {s.get("id"): s for s in (body.get("systems") or []) if isinstance(s, dict) and s.get("id")}
        self.traffic = body.get("traffic") if isinstance(body.get("traffic"), dict) else {}
        self.counts = body.get("counts") if isinstance(body.get("counts"), dict) else {}
        self._by_vmid = {}
        for b in self.bodies.values():
            m = b.get("m") or {}
            if b.get("class", "").startswith("guest_") and m.get("vmid") is not None:
                self._by_vmid.setdefault(str(m.get("vmid")), []).append(b)
        self._norm = {}
        for b in self.bodies.values():
            for nm in (b.get("label"), b.get("short")):
                k = _norm(nm)
                if k:
                    self._norm.setdefault(k, {})[b["id"]] = b

    def has(self, aid):
        return aid in self.bodies or aid in self.systems

    def body(self, bid):
        return self.bodies.get(bid)

    def by_class(self, cls, system=None):
        return [b for b in self.bodies.values()
                if b.get("class") == cls and (system is None or b.get("system") == system)]

    def guest(self, vmid, node=None):
        hits = self._by_vmid.get(str(vmid)) or []
        if node:
            hits = [b for b in hits if b.get("id", "").startswith(f"vm:{node}:")] or hits
        return hits[0] if len(hits) == 1 else None

    def match_host(self, host):
        """The single body a Zabbix host name refers to, or None."""
        k = _norm(host)
        if not k:
            return None
        hit = self._norm.get(k)
        if hit and len(hit) == 1:
            return next(iter(hit.values()))
        if hit:      # prefer an up, non-ip body (a guest over a stale client entry)
            ups = [b for b in hit.values() if b.get("status") == "up"]
            if len(ups) == 1:
                return ups[0]
        # "lab-sw1000" -> "Acme SW1000": strip a lab/demo prefix, then a unique suffix match
        tail = re.sub(r"^(lab|bench)", "", k)
        if len(tail) >= 5:
            cands = {bid: b for nk, bs in self._norm.items() if nk.endswith(tail) for bid, b in bs.items()}
            if len(cands) == 1:
                return next(iter(cands.values()))
        return None

    def featured(self):
        """The featured node's system: UI_FEATURED_NODE, else the Proxmox system with
        the most bodies (ties: the lower slot)."""
        want = config.UI_FEATURED_NODE
        if want and "sys:" + want in self.systems:
            return "sys:" + want
        pve = [s for s in self.systems.values() if s.get("kind") == "pvehost"]
        if not pve:
            return next(iter(self.systems), "sys:core")
        return max(pve, key=lambda s: (s.get("count") or 0, -(s.get("slot") or 0)))["id"]

    def resolve(self, cands):
        """First candidate that exists in the universe. Without a universe, the
        first literal id is returned unchecked (the screens cannot fly anywhere yet)."""
        feat = self.featured() if self.known else None
        cands = [feat if c == "@featured" else
                 ((c[0], feat, c[2]) if isinstance(c, tuple) and c[1] == "@featured" else c)
                 for c in cands]
        if not self.known:
            return next((c for c in cands if isinstance(c, str) and c != "@featured"), "sys:core")
        for c in cands:
            if isinstance(c, str):
                if self.has(c):
                    return c
                continue
            kind, system, arg = c
            pool = [b for b in self.bodies.values() if system is None or b.get("system") == system]
            if kind == "class":
                hits = [b for b in pool if b.get("class") == arg]
            elif kind == "cat":
                hits = [b for b in pool if b.get("cat") == arg and str(b.get("class", "")).startswith("guest_")]
            else:
                rx = re.compile(arg, re.I)
                hits = [b for b in pool if rx.search(str(b.get("label") or "")) or rx.search(str(b.get("short") or ""))]
            # a Proxmox guest before a Kubernetes pod of the same name: the guest has a host stop to follow
            hits.sort(key=lambda b: (b.get("status") != "up",
                                     (self.systems.get(b.get("system")) or {}).get("kind") != "pvehost", b.get("id")))
            if hits:
                return hits[0]["id"]
        # the system itself was missing too: any system rather than a dead anchor
        return next(iter(self.systems), cands[-1] if isinstance(cands[-1], str) else "sys:core")

    def stop_after(self, anchor, default):
        """The tour stop an aspect follows: the Proxmox host stop when its anchor sits
        in a node's galaxy ("@host"), else the given default ("wan", "fabric")."""
        sid = anchor if anchor in self.systems else (self.bodies.get(anchor) or {}).get("system")
        sysrec = self.systems.get(sid) or {}
        if sysrec.get("kind") == "pvehost":
            return "host:pve:" + sid.split(":", 1)[1]
        if default != "@host":
            return default
        return "fabric" if sid in ("sys:core", "sys:home") else "wan"


def _norm(s):
    return re.sub(r"[^0-9a-z]", "", str(s or "").lower())


# ------------------------------------------------------------------ aspects --
def _aspect(facts, line, sources_up, status=None, story=None):
    """facts: list of facts (None entries dropped). sources_up False -> unknown.
    story: candidate lines for the wall's story layer; absent when the feed is down,
    so a dead feed never puts a number on the big line."""
    facts = [f for f in facts if f][:4]
    if not sources_up or not facts:
        return {"status": "unknown", "facts": [dict(UNAVAILABLE)], "line": line or "Feed unavailable"}
    st = status or _worst(facts) or "ok"
    out = {"status": st, "facts": facts, "line": line}
    s = _stories(story or [])
    if s:
        out["story"] = s
    return out


def asp_internet(D, U, S, now):
    uf = D.get("unifi") or {}
    unifi_ok = isinstance(uf, dict) and bool(uf) and not uf.get("error")
    tel = D.get("telemetry") or {}
    tel_ok = _fresh(tel, now)
    inet = (U.body("name:internet") or {}).get("m") or {}
    rx = tel.get("wan_rx_mbps") if tel_ok and _num(tel.get("wan_rx_mbps")) is not None else (uf.get("rx") if unifi_ok else None)
    tx = tel.get("wan_tx_mbps") if tel_ok and _num(tel.get("wan_tx_mbps")) is not None else (uf.get("tx") if unifi_ok else None)
    lat = _num(uf.get("latency")) if unifi_ok else None
    if not lat:                      # UniFi reports 0 when it has no sample: absent, not 0 ms
        lat = _num(inet.get("inet_ms")) or None
    loss = _num(inet.get("loss"))
    wan = str(uf.get("wan_up") or "").lower() if unifi_ok else ""
    wan_s = "" if not wan or wan == "?" else ("ok" if wan == "ok" else "crit")
    facts = []
    if rx is not None:
        facts.append(_fact("Down", _rate(rx), "Mb/s", ""))
    if tx is not None:
        facts.append(_fact("Up", _rate(tx), "Mb/s", ""))
    if lat is not None:
        facts.append(_fact("Latency", _fmt(lat), "ms", "ok" if lat < 80 else ("warn" if lat < 250 else "crit")))
    if loss is not None:
        facts.append(_fact("Loss", _fmt(loss), "%", "ok" if loss < 2 else ("warn" if loss < 50 else "crit")))
    isp = str(uf.get("isp") or inet.get("isp") or "").strip()
    if wan_s == "crit":
        line = "Internet link down"
        facts.insert(0, _fact("WAN", "Down", None, "crit"))
    elif lat is not None:
        line = "{} link up, {} ms to the internet".format(isp or "Internet", _fmt(lat))
    else:
        line = "%s link up" % (isp or "Internet")
    st = _worst(facts + ([{"s": wan_s}] if wan_s else []))
    story = []
    if wan_s == "crit":
        story.append(_story("Internet link is down", "status", 1))
    if loss is not None and loss >= 2:
        story.append(_story("%s %% packet loss to the internet" % _fmt(loss), "status", 2))
    if rx is not None and tx is not None:
        story.append(_story("%s Mb/s down · %s Mb/s up right now" % (_rate(rx), _rate(tx)), "rate", 1))
    elif rx is not None:
        story.append(_story("%s Mb/s coming in from the internet" % _rate(rx), "rate", 1))
    if lat is not None:
        story.append(_story("%s ms to the internet%s" % (_fmt(lat), (" via " + isp) if isp else ""), "rate", 2)
                     or _story("%s ms to the internet" % _fmt(lat), "rate", 2))
    return _aspect(facts, line, unifi_ok or tel_ok or bool(inet), st or None, story)


THREAT = {0: ("Normal", "ok"), 1: ("Elevated", "warn"), 2: ("High", "warn"), 3: ("Severe", "warn")}


def asp_security(D, U, S, now):
    edge = D.get("edge") or {}
    tel = D.get("telemetry") or {}
    tel_ok = _fresh(tel, now)
    sm = edge.get("secmon") or {}
    sm_ok = _fresh(sm, now)
    cf = edge.get("cloudflare") or {}
    cf_ok = isinstance(cf, dict) and bool(cf) and _fresh(dict(cf, up=True), now)
    cs = edge.get("crowdsec") or {}
    cs_ok = _fresh(cs, now)
    facts = []
    # attacks: Prometheus cs_alerts increase over 24 h (the cscli export can read 0
    # while the metric counts real alerts); fall back to the export
    attacks = None
    if tel_ok and isinstance(tel.get("cs_by_scn"), dict):
        attacks = sum(_num(v) or 0 for v in tel["cs_by_scn"].values())
    elif cs_ok and _num(cs.get("alerts_24h")) is not None:
        attacks = _num(cs.get("alerts_24h"))
    if attacks is not None:
        facts.append(_fact("Attacks 24h", _fmt(attacks)))
    banned = _num(tel.get("cs_banned")) if tel_ok else None
    if banned is None and cs_ok:
        banned = _num(cs.get("banned"))
    if banned is not None:
        facts.append(_fact("Banned IPs", _fmt(banned)))
    level = None
    story = []
    if sm_ok and _num(sm.get("threat_level")) is not None:
        level = max(0, min(3, int(_num(sm.get("threat_level")))))
        name, s = THREAT[level]
        last = sm.get("last_24h") or {}
        ncrit = int(_num(last.get("CRITICAL")) or 0)
        if level >= 3 and ncrit > 0:
            s = "crit"            # new critical findings today, not just an unacked backlog
            story.append(_story("%s today at the edge" % _plural(ncrit, "critical security finding"), "status", 1)
                         or _story("%s critical security findings today" % _fmt(ncrit), "status", 1))
        facts.append(_fact("Threat", name, None, s))
    if cf_ok and cf.get("up") is not False and _num(cf.get("ha_connections")) is not None:
        n = int(_num(cf.get("ha_connections")))
        facts.append(_fact("Tunnel", f"{n} / 4" if n <= 4 else str(n), "links",
                           "ok" if n >= 4 else ("warn" if n > 0 else "crit")))
        if n <= 4:
            story.append(_story("%d of 4 Cloudflare tunnel links up" % n, "status" if n < 4 else "count", 1 if n < 4 else 3))
    elif cf_ok and cf.get("up") is False:
        facts.append(_fact("Tunnel", "Down", None, "crit"))
        story.append(_story("Cloudflare tunnel is down", "status", 1))
    if attacks is not None:
        story.append(_story("%s blocked in the last 24 h" % _plural(attacks, "attack"), "rate", 1))
    if banned is not None:
        story.append(_story("%s IPs banned at the edge right now" % _fmt(banned), "count", 1))
    if attacks is not None:
        line = "{} blocked in the last 24 h".format(_plural(attacks, "attack"))
    elif level is not None:
        line = f"Threat level {THREAT[level][0].lower()}"
    else:
        line = "Edge protection"
    return _aspect(facts, line, tel_ok or sm_ok or cf_ok or cs_ok, None, story)


def _site_short(host, own=None):
    """A host on the operator's own DOMAIN, shortened ("shop.example.com" -> "shop").
    IPs and every other domain (e.g. sites hosted for someone else) are never named."""
    own = str(own if own is not None else (config.DOMAIN or "")).lower().strip(".")
    h = str(host or "").lower().strip(".")
    if not own:
        return None
    if h == own:
        return own
    if h.endswith("." + own):
        sub = h[:-len(own) - 1]
        return sub if re.fullmatch(r"[a-z0-9-]{1,14}", sub) else None
    return None


def asp_web(D, U, S, now):
    a = (D.get("edge") or {}).get("audience") or {}
    ok = _fresh(a, now)
    facts = []
    now5, hr = (_num(a.get("viewers_5m")), _num(a.get("viewers_1h"))) if ok else (None, None)
    if now5 is not None:
        facts.append(_fact("Viewers now", _fmt(now5)))
    if hr is not None:
        facts.append(_fact("This hour", _fmt(hr)))
    cc = None
    if ok and isinstance(a.get("by_country"), list):
        cc = len({r.get("cc") for r in a["by_country"] if r.get("cc") and r.get("cc") != "??"})
        facts.append(_fact("Countries", _fmt(cc)))
    if ok and isinstance(a.get("by_host"), list):
        rows = sorted((r for r in a["by_host"] if _site_short(r.get("host"))),
                      key=lambda r: (-(_num(r.get("uniques")) or 0), -(_num(r.get("requests")) or 0)))
        if rows:
            facts.append(_fact("Top site", _site_short(rows[0]["host"])))
    story = []
    if now5 is not None:
        story.append(_story("%s on the websites right now" % _plural(now5, "visitor"), "count", 1))
    if hr is not None and cc:
        line = "{} from {} this hour".format(_plural(hr, "visitor"), _plural(cc, "country", "countries"))
        story.append(_story("%s this hour from %s" % (_plural(hr, "visitor"), _plural(cc, "country", "countries")), "count", 2))
    elif hr is not None:
        line = "{} this hour".format(_plural(hr, "visitor"))
        story.append(_story("%s on the websites this hour" % _plural(hr, "visitor"), "count", 2))
    else:
        line = "Public websites"
    return _aspect(facts, line, ok, None, story)


def asp_wifi(D, U, S, now):
    uf = D.get("unifi") or {}
    ok = isinstance(uf, dict) and bool(uf) and not uf.get("error")
    facts = []
    wifi = _num(uf.get("wifi")) if ok else None
    allc = _num(uf.get("clients")) if ok else None
    if wifi is not None:
        facts.append(_fact("Wi-Fi", _fmt(wifi), "clients"))
    if allc is not None:
        facts.append(_fact("All clients", _fmt(allc)))
    aps = [b for b in U.by_class("ap") if not b.get("lab")]
    up = sum(1 for b in aps if b.get("status") == "up")
    if aps:
        facts.append(_fact("APs", f"{up} / {len(aps)}", None,
                           "ok" if up == len(aps) else ("crit" if up == 0 else "warn")))
    tel = D.get("telemetry") or {}
    apc = tel.get("ap_clients") if _fresh(tel, now) else None
    if isinstance(apc, dict) and len(apc) > 1:
        busiest = max(apc.items(), key=lambda kv: _num(kv[1]) or 0)
        facts.append(_fact("Busiest AP", (U.match_host(busiest[0]) or {}).get("short") or busiest[0][:14]))
    story = []
    if aps and up < len(aps):
        story.append(_story("%d of %d access points down" % (len(aps) - up, len(aps)), "status", 1))
    if wifi is not None and aps:
        story.append(_story("%s Wi-Fi %s on %s" % (_fmt(wifi), "client" if int(wifi) == 1 else "clients",
                                                    _plural(len(aps), "access point")), "count", 1))
    elif wifi is not None:
        story.append(_story("%s Wi-Fi %s connected" % (_fmt(wifi), "client" if int(wifi) == 1 else "clients"), "count", 1))
    if allc is not None:
        story.append(_story("%s on the network right now" % _plural(allc, "client"), "count", 2))
    if wifi is not None and aps:
        line = "{} wireless {} on {}".format(_fmt(wifi), "client" if int(wifi) == 1 else "clients",
                                         _plural(len(aps), "access point"))
    elif allc is not None:
        line = "{} on the network".format(_plural(allc, "client"))
    else:
        line = "Wireless network"
    return _aspect(facts, line, ok or bool(aps), None, story)


def _backup_fact(b):
    runs = [r for r in (b.get("runs") or []) if isinstance(r, dict) and _num(r.get("start"))]
    if not runs:
        return None, None
    last = max(_num(r["start"]) for r in runs)
    batch = [r for r in runs if last - _num(r["start"]) < 20 * 3600]      # tonight's jobs on every node
    ok = sum(int(_num(r.get("ok")) or 0) for r in batch)
    tot = sum(int(_num(r.get("guests")) or 0) for r in batch)
    failed = sum(int(_num(r.get("failed")) or 0) for r in batch)
    t0 = min(_num(r["start"]) for r in batch)
    s = "ok" if failed == 0 and ok == tot else ("crit" if ok == 0 else "warn")
    if any(str(r.get("state") or "ok") not in ("ok", "running") for r in batch) and s == "ok":
        s = "warn"
    return _fact("Last backup", f"{_local_hm(t0)} · {ok} / {tot}", None, s), (ok, tot, failed)


def asp_storage(D, U, S, now):
    facts = []
    pools = D.get("zfs") if isinstance(D.get("zfs"), list) and D.get("zfs") else None
    rows = []
    for p in pools or (D.get("pools") if isinstance(D.get("pools"), list) else []) or []:
        size = _num(p.get("size"))
        if not size:
            continue
        cap = _num(p.get("cap"))
        used = size * cap / 100 if cap is not None else (_num(p.get("alloc")) or 0)
        state = str(p.get("state") or p.get("health") or "").upper()
        errs = p.get("errs") or {}
        nerr = sum(_num(v) or 0 for v in errs.values()) if isinstance(errs, dict) else 0
        rows.append((size, used, state, nerr, bool(p.get("bad"))))
    if rows:
        pct = 100 * sum(r[1] for r in rows) / sum(r[0] for r in rows)
        worst = max(rows, key=lambda r: r[1] / r[0])
        wp = 100 * worst[1] / worst[0]
        s = "ok"
        if any(r[2] in ("FAULTED", "UNAVAIL", "SUSPENDED") for r in rows):
            s = "crit"
        elif any(r[2] not in ("ONLINE", "") or r[3] or r[4] for r in rows) or wp >= 80:
            s = "warn"
        if wp >= 90:
            s = "crit"
        facts.append(_fact("ZFS", _fmt(pct), "% used", s))
    b = D.get("backups") or {}
    bf, bstat = (_backup_fact(b) if isinstance(b, dict) and not b.get("error") else (None, None))
    if bf:
        facts.append(bf)
    tel = D.get("telemetry") or {}
    tel_ok = _fresh(tel, now)
    drives = None
    if tel_ok and isinstance(tel.get("smart_n"), dict) and tel["smart_n"]:
        drives = int(sum(_num(v) or 0 for v in tel["smart_n"].values()))
        bad = int(_num(tel.get("smart_bad")) or 0)
        facts.append(_fact("Drives", f"{drives} ok" if not bad else f"{bad} failing", None,
                           "ok" if not bad else "crit"))
    if tel_ok and isinstance(tel.get("smart_hot"), dict) and tel["smart_hot"]:
        hot = max(_num(v) or 0 for v in tel["smart_hot"].values())
        facts.append(_fact("Hottest", _fmt(hot), "°C", "ok" if hot < 50 else ("warn" if hot < 60 else "crit")))
    parts = []
    story = []
    if rows:
        online = sum(1 for r in rows if r[2] == "ONLINE")
        parts.append("{} online".format(_plural(online, "pool")) if online == len(rows)
                     else f"{online} of {len(rows)} pools online")
        if online < len(rows):
            story.append(_story("%d of %d ZFS pools not online" % (len(rows) - online, len(rows)), "status", 1))
        tib = sum(r[0] for r in rows) / 1024.0 ** 4
        story.append(_story("ZFS %s TB · %s %% used" % (_fmt(tib), _fmt(pct)), "count", 1))
    if bstat:
        parts.append(f"last backup {bstat[0]} of {bstat[1]} ok")
        if bstat[2]:
            story.append(_story("%s failed in last night's backup" % _plural(bstat[2], "guest"), "status", 1))
    bk = b if isinstance(b, dict) and not b.get("error") and not b.get("unknown") else {}
    if _num(bk.get("backed")) is not None and _num(bk.get("guests")):
        story.append(_story("%d of %d guests backed up" % (_num(bk["backed"]), _num(bk["guests"])), "count", 1))
        if _num(bk.get("missing")):
            story.append(_story("%s without a backup" % _plural(_num(bk["missing"]), "guest"), "status", 2))
    elif bstat:
        story.append(_story("%d of %d guests backed up overnight" % (bstat[0], bstat[1]), "count", 1))
    if drives is not None:
        bad = int(_num(tel.get("smart_bad")) or 0)
        if bad:
            story.append(_story("%s failing" % _plural(bad, "drive"), "status", 1))
        elif tel_ok and isinstance(tel.get("smart_hot"), dict) and tel["smart_hot"]:
            story.append(_story("%d drives healthy, hottest %s °C" % (drives, _fmt(max(_num(v) or 0 for v in tel["smart_hot"].values()))), "count", 2))
        else:
            story.append(_story("%d drives healthy" % drives, "count", 2))
    line = (", ".join(parts) or "Storage").capitalize() if parts else "Storage"
    line = line[0].upper() + line[1:]
    return _aspect(facts, line, bool(rows) or bool(bf) or drives is not None, None, story)


def _gpu_watts(S, now):
    gs = (S or {}).get("gpu_series") or {}
    polled = ((S or {}).get("polled") or {}).get("gpu_series")
    if polled and now - polled > SHOW_STALE_S:
        return None
    total, seen = 0.0, False
    for g in gs.get("gpus") or []:
        p = [x for x in (g.get("power") or []) if _num(x) is not None]
        if p:
            total += sum(p) / len(p)       # mean over the 60 s window: instantaneous NVML power jumps
            seen = True
    return total if seen else None


def asp_power(D, U, S, now):
    tel = D.get("telemetry") or {}
    ok = _fresh(tel, now)
    facts = []
    w = _num(tel.get("watts")) if ok else None
    if w is not None:
        facts.append(_fact("Server", _fmt(w), "W"))
    gw = _gpu_watts(S, now)
    if gw is not None:
        facts.append(_fact("GPUs", _fmt(gw), "W"))
    inlet = _num(tel.get("inlet_c")) if ok else None
    if inlet is not None:
        facts.append(_fact("Inlet", _fmt(inlet), "°C", "ok" if inlet < 35 else ("warn" if inlet < 42 else "crit")))
    fan = _num(tel.get("fan_max")) if ok else None
    if fan is not None:
        facts.append(_fact("Fans", _fmt(fan), "rpm"))
    story = []
    if inlet is not None and inlet >= 42:
        story.append(_story("Inlet air at %s °C, too warm" % _fmt(inlet), "status", 1))
    if w is not None:
        story.append(_story("Servers drawing %s W right now" % _fmt(w), "rate", 1))
    if gw is not None:
        story.append(_story("GPUs drawing %s W right now" % _fmt(gw), "rate", 2))
    if inlet is not None:
        story.append(_story("Inlet air at %s °C" % _fmt(inlet), "count", 3))
    if w is not None and inlet is not None:
        line = f"Server drawing {_fmt(w)} W at {_fmt(inlet)} °C inlet"
    elif w is not None:
        line = f"Server drawing {_fmt(w)} W"
    else:
        line = "Power and cooling"
    return _aspect(facts, line, ok or gw is not None, None, story)


def asp_monitoring(D, U, S, now, problems):
    facts = []
    z = D.get("zabbix") or {}
    z_ok = isinstance(z, dict) and "alert_hosts" in z and not z.get("error")
    crit_hosts = [p for p in problems if p["sev"] >= 4 and not p["lab"]]
    if z_ok:
        n = len(crit_hosts)
        facts.append(_fact("Problems", _fmt(n), None, "crit" if n else "ok"))
    tel = D.get("telemetry") or {}
    tel_ok = _fresh(tel, now)
    so, st = (_num(tel.get("slo_ok")), _num(tel.get("slo_total"))) if tel_ok else (None, None)
    if so is not None and st:
        facts.append(_fact("Endpoints", f"{int(so)} / {int(st)}", None,
                           "ok" if so >= st else ("crit" if so <= st / 2 else "warn")))
    c = D.get("certs") or {}
    md = _num(c.get("min_days")) if isinstance(c, dict) and _fresh(c, now, 2 * 86400) else None
    if md is not None:
        facts.append(_fact("TLS", _fmt(md), "d", "ok" if md >= 21 else ("warn" if md >= 7 else "crit")))
    h = [x for x in (D.get("health") or []) if isinstance(x, dict) and "up" in x]
    if h:
        up = sum(1 for x in h if x.get("up"))
        facts.append(_fact("Checks", f"{up} / {len(h)}", None,
                           "ok" if up == len(h) else ("crit" if up <= len(h) / 2 else "warn")))
    hosts = _num(z.get("hosts")) if z_ok else None
    story = []
    if z_ok and crit_hosts:
        story.append(_story("%s with critical problems" % _plural(len(crit_hosts), "host"), "status", 1))
    elif z_ok and hosts:
        story.append(_story("%s watched, no critical problems" % _plural(hosts, "host"), "count", 1))
    if so is not None and st:
        story.append(_story("%d of %d endpoints up" % (so, st), "status" if so < st else "count", 1 if so < st else 2))
    if h:
        story.append(_story("%d of %d synthetic checks passing" % (up, len(h)), "status" if up < len(h) else "count", 1 if up < len(h) else 2))
    if md is not None:
        story.append(_story("TLS certificates good for %s more days" % _fmt(md), "age", 3))
    if z_ok and crit_hosts:
        line = "{} watched, {} with critical problems".format(_plural(hosts or 0, "host"), _fmt(len(crit_hosts)))
    elif z_ok:
        line = "All systems normal across {}".format(_plural(hosts or 0, "host")) if hosts else "All systems normal"
    else:
        line = "Zabbix feed unavailable"
    return _aspect(facts, line, z_ok or tel_ok or bool(h) or md is not None, None, story)


def asp_ai(D, U, S, now):
    facts = []
    show = S or {}
    polled = (show.get("polled") or {}).get("ollama")
    inst = [i for i in (show.get("ollama") or []) if isinstance(i, dict)]
    if polled and now - polled > SHOW_STALE_S:
        inst = []
    up = [i for i in inst if i.get("up")]
    loaded = [m for i in up for m in (i.get("loaded") or [])]
    if inst:
        facts.append(_fact("Loaded", _fmt(len(loaded)), "model" if len(loaded) == 1 else "models",
                           "ok" if len(up) == len(inst) else ("crit" if not up else "warn")))
        vram = sum(_num(i.get("vram_used_mb")) or 0 for i in up)
        facts.append(_fact("VRAM", _fmt(vram / 1024, 1), "GB"))
    r_ok, _calls = False, None
    if not inst:       # showtime missing: fall back to the discovered AI servers
        srv = [s for s in (D.get("ai_servers") or []) if isinstance(s, dict)]
        if srv:
            sup = sum(1 for s in srv if s.get("ollama_up") or s.get("up"))
            facts.insert(0, _fact("Servers", f"{sup} / {len(srv)}", None,
                                  "ok" if sup == len(srv) else ("crit" if not sup else "warn")))
    story = []
    if inst and not up:
        story.append(_story("Ollama is down", "status", 1))
    if inst and up:
        story.append(_story("%s loaded, %s GB of VRAM" % (_plural(len(loaded), "model"), _fmt(vram / 1024, 1)), "count", 1))
    if loaded:
        names = sorted({str(m.get("name") or "") for m in loaded if m.get("name")})
        where = next((i.get("gpu_label") for i in up if i.get("loaded")), None)
        line = "{} loaded{}".format(names[0] if len(names) == 1 else _plural(len(names), "model"),
                                (" on the " + where) if where else "")
    elif up:
        line = "Ollama up, no model loaded"
    else:
        line = "Local AI"
    return _aspect(facts, line, bool(inst) or r_ok or bool(D.get("ai_servers")), None, story)


def asp_cameras(D, U, S, now):
    facts = []
    fr = D.get("frigate") or {}
    fr_ok = isinstance(fr, dict) and bool(fr) and not fr.get("error")
    show = S or {}
    sf = show.get("frigate") or {}
    sf_polled = (show.get("polled") or {}).get("frigate")
    sf_ok = isinstance(sf, dict) and sf.get("up") is True and not (sf_polled and now - sf_polled > SHOW_STALE_S)
    names = [c for c in (D.get("cameras") or []) if isinstance(c, str)]
    live = None
    cams = (fr.get("cams") if fr_ok else None) or ([{"name": c.get("name"), "fps": c.get("fps")}
                                                     for c in sf.get("cameras") or []] if sf_ok else None)
    down_feed = (fr_ok and fr.get("up") is False) or (isinstance(sf, dict) and sf.get("up") is False and not fr_ok)
    if cams is not None:
        total = max(len(names), len(cams))
        live = sum(1 for c in cams if (_num(c.get("fps")) or 0) > 0.5)
        facts.append(_fact("Recording", f"{live} / {total}", None,
                           "ok" if live == total else ("crit" if live == 0 else "warn")))
    elif down_feed and names:
        facts.append(_fact("Recording", "Down", None, "crit"))
    ms = _num(sf.get("inference_ms")) if sf_ok else None
    if ms is None and fr_ok and isinstance(fr.get("det_ms"), dict) and fr["det_ms"]:
        ms = _num(next(iter(fr["det_ms"].values())))
    if ms is not None:
        facts.append(_fact("Detector", _fmt(ms, 1), "ms", "ok" if ms < 30 else "warn"))
    ev = [e for e in (sf.get("events") or []) if isinstance(e, dict)] if sf_ok else []
    story = []
    if live is not None:
        story.append(_story("%d of %d cameras recording" % (live, total), "status" if live < total else "count", 1))
    elif down_feed and names:
        story.append(_story("Cameras are not recording", "status", 1))
    if ev:
        e = max(ev, key=lambda e: _num(e.get("start")) or 0)
        age = now - _num(e.get("start")) if _num(e.get("start")) else _num(e.get("age"))
        lbl = str(e.get("label") or "object").replace("_", " ").capitalize()
        facts.append(_fact("Last event", lbl, _ago(age) if age is not None else None))
        if age is not None:
            ago = ("%d s ago" % age) if age < 90 else _ago(age)
            if live is not None and live == total and live >= 2:
                # the line a stranger repeats: how many eyes, and what they last saw
                story.append(_story("%d cameras recording \u00b7 last %s %s" % (live, lbl.lower(), ago), "count", 0))
            story.append(_story("Last %s seen %s" % (lbl.lower(), ago), "age", 2))
    if ms is not None:
        story.append(_story("Detector at %s ms per frame" % _fmt(ms, 1), "count", 3))
    days = _num((fr.get("rec") or {}).get("est_days")) if fr_ok else None
    if days is not None:
        facts.append(_fact("Retention", "~" + _fmt(round(days, -1) if days >= 100 else days), "d"))
        story.append(_story("About %s of recordings kept" % _plural(round(days, -1) if days >= 100 else days, "day"), "age", 3))
    elif fr_ok and _num((fr.get("rec") or {}).get("pct")) is not None:     # estimate not ready yet
        pct = _num(fr["rec"]["pct"])
        facts.append(_fact("Disk used", _fmt(pct, 1), "%", "ok" if pct < 85 else ("warn" if pct < 95 else "crit")))
    if live is not None:
        line = ("{} recording".format(_plural(live, "camera"))) + (", about {} of storage".format(_plural(round(days, -1) if days >= 100 else days, "day")) if days else "")
    elif down_feed:
        line = "Frigate is not responding"
    else:
        line = "Cameras"
    return _aspect(facts, line, fr_ok or sf_ok or bool(down_feed and names), None, story)


_MEDIA_CHECKS = ("emby", "jellyfin", "plex")


def asp_media(D, U, S, now):
    facts = []
    show = S or {}
    e = show.get("emby") or {}
    polled = (show.get("polled") or {}).get("emby")
    stale = bool(polled and now - polled > SHOW_STALE_S)
    configured = isinstance(e, dict) and e.get("configured", True) and not stale and "up" in e
    if configured and e.get("up"):
        sess = int(_num(e.get("count")) if _num(e.get("count")) is not None else len(e.get("sessions") or []))
        play = [p for p in (e.get("playing") or []) if isinstance(p, dict) and not p.get("paused")]
        tc = sum(1 for p in play if p.get("transcode"))
        facts.append(_fact("Sessions", _fmt(sess)))
        facts.append(_fact("Playing", _fmt(len(play))))
        facts.append(_fact("Transcoding", _fmt(tc)))
        live = [p for p in play if p.get("live") and p.get("title")]
        if live:      # a channel name is not personal; a film or episode someone is watching is
            facts.append(_fact("Live TV", str(live[0]["title"]).split(" · ")[0][:16]))
        story = []
        if play:
            line = "{} playing{}".format(_plural(len(play), "stream"), f", {tc} transcoding" if tc else "")
            story.append(_story("%s playing on the media server%s" % (_plural(len(play), "stream"), (", %d transcoding" % tc) if tc else ""), "count", 1))
        else:
            line = "Media server up, {} connected, nothing playing".format(_plural(sess, "session"))
        story.append(_story("%s connected to the media server" % _plural(sess, "session"), "count", 2))
        return _aspect(facts, line, True, "ok", story)
    if configured and e.get("up") is False:
        h = next((x for x in (D.get("health") or []) if isinstance(x, dict) and str(x.get("name", "")).lower() in _MEDIA_CHECKS), None)
        if h and h.get("up"):      # the API failed but the web check passes: degraded, not down
            return _aspect([_fact("Server", "Up", None, "ok"), _fact("Sessions", "unavailable", None, "warn")],
                           "Media server up, session feed unavailable", True, None,
                           [_story("Media server up, session feed unavailable", "status", 2)])
        return _aspect([_fact("Server", "Down", None, "crit")], "Media server is not responding", True, None,
                       [_story("Media server is not responding", "status", 1)])
    h = next((x for x in (D.get("health") or []) if isinstance(x, dict)
              and str(x.get("name", "")).lower() in _MEDIA_CHECKS), None)
    if h:
        return _aspect([_fact("Server", "Up" if h.get("up") else "Down", None, "ok" if h.get("up") else "crit")],
                       "Media server up" if h.get("up") else "Media server is not responding", True, None,
                       [_story("Media server is up" if h.get("up") else "Media server is not responding", "status", 2)])
    return _aspect([], "Media server", False)


# ----------------------------------------------------------------- problems --
_PAREN_ID = re.compile(r"\s*\((?:CT|VM|LXC)\s*\d+\)", re.I)
_PVE = re.compile(r"^Proxmox:\s*(VM|LXC)\s*\[(?P<node>[^/\]]+)/(?P<name>[^\]\(]+?)\s*(?:\((?:qemu|lxc)/(?P<id>\d+)\))?\]:\s*(?P<what>.*)$", re.I)
_PREFIX = re.compile(r"^(?:Alcatel\s+Timetra\s+TiMOS|Cisco\s+IOS(?:\s*XR)?|Juniper\s+Junos|Generic\s+SNMP|Linux|Windows|Proxmox|ICMP|Juniper|Cisco|Nokia|ADVA|Interface|Generic|SNMP|HTTP|DEMO|MikroTik|Ubiquiti|UniFi)\s*:\s*", re.I)
# "security-mon · active CRITICAL security finding" -> "critical finding" (contracts 9.3: no template boilerplate)
_FINDING = re.compile(r"^(?:active\s+)?(critical|high|medium|low)\s+security\s+finding", re.I)

# (pattern on the cleaned text, replacement text)
_RULES = [
    (re.compile(r"\bis unreachable\b|\bunreachable for \d+", re.I), "unreachable"),
    (re.compile(r"^Unavailable by ICMP ping", re.I), "no ping response"),
    (re.compile(r"High ICMP ping loss", re.I), "packet loss"),
    (re.compile(r"High ICMP ping response time", re.I), "slow ping"),
    (re.compile(r"System status is in critical state", re.I), "status critical"),
    (re.compile(r"System status is in warning state", re.I), "status warning"),
    (re.compile(r"^High CPU\b", re.I), "high CPU"),
    (re.compile(r"High swap space usage", re.I), "high swap use"),
    (re.compile(r"High memory utili[sz]ation|Lack of available memory", re.I), "low memory"),
    (re.compile(r"Too many processes", re.I), "too many processes"),
    (re.compile(r"Disk space (?:warning|is low|is critically low)", re.I), "low disk space"),
    (re.compile(r"has been restarted", re.I), "restarted"),
    (re.compile(r"Zabbix agent is not available|agent .*not available", re.I), "agent unavailable"),
]
_IFACE = re.compile(r"^Interface\s+(?P<if>[^()\s:]+)\((?P<alias>[^)]*)\)\s*:\s*(?P<what>.+)$", re.I)
_ACRONYM = re.compile(r"^(?:[A-Z0-9][A-Z0-9+/.-]*[A-Z0-9+]|[A-Z][a-z]+[A-Z]\w*)\b")
PROBLEM_MAX = 32


def problem_text(raw, host=None):
    """Zabbix problem name -> short plain text. Returns (text, vmid or None, kind)."""
    s = " ".join(str(raw or "").split())
    s = re.sub(r"\s*\(?\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b\)?", "", s)      # never an IP on screen
    s = re.sub(r"\s+(?:on|at|from|to|for|via)\s*(?=$|[,;])", "", s)          # "... down on <ip>" leftovers
    vmid = None
    m = _PVE.match(s)
    if m:
        kind = "CT" if m.group(1).upper() == "LXC" else "VM"
        vmid = m.group("id")
        what = m.group("what").strip()
        subj = (f"{kind} {vmid}") if vmid else m.group("name").strip()
        if re.match(r"^not\s*r", what, re.I) or re.match(r"^not\b", what, re.I):
            return f"{subj} not running", vmid, "not_running"
        if re.match(r"^has\s+been\s+r", what, re.I):
            return f"{subj} restarted", vmid, "restart"
        return (f"{subj} {_lower_first(_tidy(what))}").strip(), vmid, "other"
    pm = re.search(r"\((?:CT|VM|LXC)\s*(\d+)\)", s, re.I)
    if pm:
        vmid = pm.group(1)
    s = _PAREN_ID.sub("", s)
    s = re.sub(r"\s*\(synthetic\)", "", s, flags=re.I)
    for _ in range(2):
        s = _PREFIX.sub("", s)
    if host:                                     # "freeradius: FreeRADIUS port 1812 ..." / "pve1: Too many"
        s = re.sub(rf"^{re.escape(host)}\s*:\s*", "", s, flags=re.I)
    fm = _FINDING.match(s)
    if fm:
        return f"{fm.group(1).lower()} finding", vmid, "finding"
    im = _IFACE.match("Interface " + s if not s.lower().startswith("interface") else s)
    if im and ":" in s:
        name = im.group("alias").strip() or im.group("if")
        what = _lower_first(_tidy(im.group("what").strip()))
        return _clip(f"{name} {what}"), vmid, "iface"
    for rx, rep in _RULES:
        if rx.search(s):
            return rep, vmid, rep.replace(" ", "_")
    if host:                                     # leading word that only repeats the host name
        s = re.sub(r"^{}\b\s*".format(re.escape(re.sub(r"[-_]", " ", host))), "", s, flags=re.I) or s
        hk = _norm(host)
        first = s.split(" ", 1)
        if len(first) == 2 and _norm(first[0]) == hk:
            s = first[1]
    s = _tidy(s)
    return _clip(_lower_first(s)), vmid, "other"


def _tidy(s):
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s)      # trailing thresholds "(>3000)", "(less than 50% free)"
    s = re.sub(r"\s+(?:on|for)\s+\S+\s*$", lambda m: m.group(0) if re.search(r"\d", m.group(0)) else "", s)
    return s.strip(" .:-")


def _lower_first(s):
    if not s or _ACRONYM.match(s):
        return s
    return s[0].lower() + s[1:]


def _clip(s, n=PROBLEM_MAX):
    s = " ".join(s.split())
    if len(s) <= n:
        return s
    cut = s[:n - 1]
    if " " in cut[8:]:
        cut = cut[:cut.rindex(" ")]
    return cut.rstrip(" ,.-") + "…"


# fallback ranking when a host's per-problem severity is unknown (older poller)
_KIND_RANK = {"unreachable": 9, "no_ping_response": 8, "status_critical": 8, "packet_loss": 6,
              "iface": 5, "not_running": 3}


def _host_short(host, U):
    b = U.match_host(host)
    if b and b.get("short"):
        return b["short"], b
    try:
        import universe
        s = universe.short_name(host)
    except Exception:
        s = None
    s = s or str(host)
    return (s if len(s) <= 14 else _clip(s, 14)), b


def build_problems(D, U):
    """[{host, text, sev, lab, n}] one row per host (the worst), red-worthy first, lab last."""
    z = D.get("zabbix") or {}
    ah = z.get("alert_hosts") if isinstance(z, dict) else None
    if not isinstance(ah, dict):
        return []
    out = []
    for host, a in ah.items():
        if not isinstance(a, dict):
            continue
        hshort, hb = _host_short(host, U)
        host_lab = bool(a.get("lab")) or bool(hb and hb.get("lab")) or bool(re.match(r"(?i)(lab|demo)[-_]", host))
        top = a.get("top")
        if isinstance(top, list) and top:
            items = [(int(_num(t.get("sev")) or 0), t.get("name")) for t in top if isinstance(t, dict)]
            exact = True
        else:
            items = [(int(_num(a.get("sev")) or 0), nm) for nm in (a.get("names") or [])]
            exact = False
        rows = []
        for sev, nm in items:
            text, vmid, kind = problem_text(nm, host)
            lab = host_lab or bool(re.search(r"\(synthetic\)|^DEMO:", str(nm or ""), re.I))
            node = host if hb and hb.get("class") == "pve_host" else None
            g = U.guest(vmid, node) if vmid else None
            if g is not None:
                if g.get("lab"):
                    lab = True
                if kind == "not_running" and g.get("down_why") in ("stopped", "gone"):
                    sev = min(sev, 3)          # a stopped guest is not an outage
            if not exact and kind == "not_running":
                # the host's max severity belongs to one of the names, not all of them
                sev = min(sev, 3)
            rows.append({"text": text, "sev": sev, "lab": lab, "rank": _KIND_RANK.get(kind, 4)})
        if not rows:
            continue
        rows.sort(key=lambda r: (r["lab"], -r["sev"], -r["rank"]))
        w = rows[0]
        if w["lab"]:
            w["sev"] = min(w["sev"], 3)          # lab gear never red
        out.append({"host": hshort, "text": w["text"], "sev": w["sev"], "lab": w["lab"],
                    "n": int(_num(a.get("n")) or len(rows))})
    out.sort(key=lambda p: (p["lab"], -p["sev"], -p["n"], p["host"].lower()))
    return out


# ------------------------------------------------------------------- build --
def build(D, universe_body=None, show=None, now=None):
    now = time.time() if now is None else now
    D = D if isinstance(D, dict) else {}
    U = universe_body if isinstance(universe_body, Uni) else Uni(universe_body)
    problems = build_problems(D, U)
    fns = {
        "asp:internet": asp_internet, "asp:security": asp_security, "asp:web": asp_web,
        "asp:wifi": asp_wifi, "asp:storage": asp_storage, "asp:power": asp_power,
        "asp:monitoring": lambda D_, U_, S_, n_: asp_monitoring(D_, U_, S_, n_, problems),
        "asp:ai": asp_ai, "asp:cameras": asp_cameras, "asp:media": asp_media,
    }
    aspects = []
    want = [k.strip() for k in (config.TOUR_ASPECTS or []) if k.strip()]
    table = {a[0]: a for a in ASPECTS}
    order = [table[k] for k in want if k in table] if want else ASPECTS
    for key, name, after, cands in order:
        try:
            body = fns[key](D, U, show, now)
        except Exception as e:                 # one broken feed must not take the tour down
            print(f"[tour] {key} failed: {type(e).__name__}: {e}", flush=True)
            body = _aspect([], "Feed unavailable", False)
        pin = (config.TOUR_ANCHORS or {}).get(key)
        anchor = U.resolve(([str(pin)] if pin else []) + list(cands))
        aspects.append(dict({"key": key, "name": name, "anchor": anchor,
                             "after": U.stop_after(anchor, after)}, **body))
    k8s_aspects, k8s_problems = _k8s_parts(U, now)
    if k8s_aspects or k8s_problems:
        aspects += k8s_aspects
        problems = sorted(problems + k8s_problems,
                          key=lambda p: (p["lab"], -p["sev"], -p["n"], p["host"].lower()))
    out = {"v": V, "ts": round(now), "aspects": aspects, "problems": problems}
    for k, fn in (("systems", build_systems), ("links", build_links), ("estate", build_estate)):
        try:
            v = fn(U, now)
        except Exception as e:                 # additive: the story layer is never worth a 500
            print("[tour] %s story failed: %s: %s" % (k, type(e).__name__, e), flush=True)
            v = []
        if v:
            out[k] = {"story": v} if k == "estate" else v
    return out


# ------------------------------------------------------------ system story --
# Story candidates for the stops that are not aspects (additive): one list per
# system galaxy (`systems`), per guest category of a Proxmox host (`systems[].cats`, the
# blk:<hub>:<cat> stops), per measured system-to-system stream (`links`, the stream stop)
# and one for the whole estate (`estate`, the overviews). Same honesty rules as the facts:
# measured values only, no body names (a guest can be named after a customer), no ids, no
# IPs; a body the registry marked `gone` is not part of any total, bench gear (`lab`) is
# never counted or reported.
# the wall's own acronym list (netscene.js ACRO), so a system is named alike on both
_ACRO = {"gpu": "GPU", "nas": "NAS", "nvr": "NVR", "udm": "UDM", "usw": "USW", "ai": "AI", "dns": "DNS",
         "vpn": "VPN", "wan": "WAN", "lan": "LAN", "pve": "PVE", "sd-wan": "SD-WAN", "pbs": "PBS",
         "tv": "TV", "av": "AV"}
_CAT_TITLE = {"ai": "AI", "media": "Media", "network": "Network", "monitor": "Monitoring", "web": "Web",
              "infra": "Infra"}
_CAT_WORD = {"ai": "AI", "media": "media", "network": "network", "monitor": "monitoring", "web": "web",
             "infra": "infra"}
# only these can be "offline" news: a laptop asleep or a phone out of the house is not an outage
_INFRA_CLASSES = ("pve_host", "switch", "ap", "gateway", "storage", "server", "camera", "guest_lxc", "guest_vm")
STATUS_RECENT_H = 6.0       # a status line is a CHANGE: offline for longer is old news
LINK_MIN_BPS = 1e5
CAT_MIN = 3                 # netscene.js makes a blk: stop for a category of >= 3 guests


def _sys_name(s):
    """The galaxy's product name, as the wall's caption sets it (netscene.js sysName): the
    registry's short in sentence case with the usual acronyms kept ("PVE1" -> "PVE1",
    "HOMELAB" -> "Homelab", "gpu" -> "GPU"); never an id."""
    raw = str((s or {}).get("short") or (s or {}).get("label") or str((s or {}).get("id") or "").split(":")[-1]).strip()
    if not raw:
        return "system"
    shout = bool(re.search(r"[A-Z]", raw)) and raw == raw.upper()
    out = []
    for i, t in enumerate(raw.split()):
        k = t.lower()
        m = re.match(r"^([a-z-]+?)(\d*)$", k)
        if k in _ACRO:
            out.append(_ACRO[k])
            continue
        if m and m.group(1) in _ACRO:
            out.append(_ACRO[m.group(1)] + m.group(2))
            continue
        if shout:
            t = k
        out.append(t[0].upper() + t[1:] if i == 0 else t)
    return " ".join(out)


def _bps_text(bps):
    return ("%s Mb/s" % _rate(bps / 1e6)) if bps >= 1e6 else ("%s kb/s" % _fmt(bps / 1e3))


def _first(*cands):
    """The first candidate that passed the story rule (a long form, then its shorter form)."""
    for c in cands:
        if c:
            return c
    return None


def _live(bs):
    """Bodies that count: not bench gear, not gone from the registry."""
    return [b for b in bs if not b.get("lab") and b.get("down_why") != "gone"]


def _is_guest(b):
    return str(b.get("class") or "").startswith("guest_")


def _guest_split(bs):
    up = [b for b in bs if _is_guest(b) and b.get("status") == "up"]
    return (sum(1 for b in up if b.get("class") == "guest_lxc"), sum(1 for b in up if b.get("class") == "guest_vm"))


def _guests_text(ct, vm, tail):
    if ct and vm:
        both = "%s and %s" % (_plural(ct, "container"), _plural(vm, "VM"))
        return _first(_story("%s running %s" % (both, tail), "count", 1), _story("%s %s" % (both, tail), "count", 1),
                      _story("%s running %s" % (_plural(ct + vm, "guest"), tail), "count", 1))
    if ct or vm:
        return _story("%s running %s" % (_plural(ct, "container") if ct else _plural(vm, "VM"), tail), "count", 1)
    return None


def _recent_offline(bs):
    """Infrastructure that went offline within STATUS_RECENT_H, by the registry's own clock."""
    out = []
    for b in bs:
        if b.get("status") != "down" or b.get("down_why") != "offline" or b.get("class") not in _INFRA_CLASSES:
            continue
        h = _num((b.get("m") or {}).get("offline_h"))
        if h is not None and 0 <= h <= STATUS_RECENT_H:
            out.append(b)
    return out


def _pairs(U):
    out = []
    for p in (U.traffic.get("pairs") or []):
        if isinstance(p, dict) and p.get("a") in U.systems and p.get("b") in U.systems:
            bps = _num(p.get("bps"))
            if bps is not None and bps >= 0:
                out.append((bps, p))
    return out


def _traffic_fresh(U, now):
    ts = _num(U.traffic.get("ts"))
    return ts is not None and abs(now - ts) <= STALE_S


def _sys_story(U, sid, now):
    s = U.systems.get(sid) or {}
    bs = _live([b for b in U.bodies.values() if b.get("system") == sid])
    if not bs:
        return []
    nm = _sys_name(dict(s, id=sid))
    kind = str(s.get("kind") or "")
    st = []
    off = _recent_offline(bs)
    if off and kind != "clients":
        word = "guest" if all(_is_guest(b) for b in off) else "device"
        prep = "on" if kind == "pvehost" else "at"
        st.append(_story("%s offline %s %s" % (_plural(len(off), word), prep, nm), "status", 1))
    if kind == "k8s":
        # a Kubernetes cluster's guests are its pods (k8s.py), its servers the nodes
        pods = [b for b in bs if _is_guest(b)]
        nodes = [b for b in bs if not _is_guest(b)]
        run = sum(1 for b in pods if b.get("status") == "up")
        if pods:
            st.append(_first(_story("%d of %d pods running on %s" % (run, len(pods), nm), "count", 1),
                             _story("%d of %d pods running" % (run, len(pods)), "count", 1)))
        if nodes:
            ready = sum(1 for b in nodes if b.get("status") == "up")
            st.append(_story("%d of %d nodes ready" % (ready, len(nodes)), "status" if ready < len(nodes) else "count", 2))
    elif any(_is_guest(b) for b in bs):
        ct, vm = _guest_split(bs)
        st.append(_guests_text(ct, vm, "on %s" % nm))
    elif len(bs) >= 2:
        up = sum(1 for b in bs if b.get("status") == "up")
        cams = [b for b in bs if b.get("class") == "camera"]
        if kind == "clients":
            st.append(_story("%d of %d home devices online" % (up, len(bs)), "count", 1))
        elif kind == "network":
            st.append(_story("%d of %d network devices up" % (up, len(bs)), "count", 2))
        elif len(cams) >= 2 and len(cams) >= len(bs) - 1:
            st.append(_story("%d of %d cameras streaming at %s" % (
                sum(1 for b in cams if b.get("status") == "up"), len(cams), nm), "count", 1))
        else:
            st.append(_story("%d of %d devices up at %s" % (up, len(bs), nm), "count", 1))
    if _traffic_fresh(U, now):
        mine = [(bps, p) for bps, p in _pairs(U) if sid in (p.get("a"), p.get("b"))]
        if kind == "network":
            # the core is what everything crosses: the sum of its measured streams
            tot = sum(bps for bps, _ in mine)
            if tot >= LINK_MIN_BPS:
                st.append(_first(_story("%s crossing the network core right now" % _bps_text(tot), "rate", 1),
                                 _story("%s crossing the core right now" % _bps_text(tot), "rate", 1),
                                 _story("%s crossing the network core" % _bps_text(tot), "rate", 1)))
        elif kind != "pvehost" and mine:
            # a host's own stream is the stream stop's line (`links`); its stop shows what runs on it
            bps, p = max(mine, key=lambda x: x[0])
            if bps >= LINK_MIN_BPS:
                other = p["b"] if p["a"] == sid else p["a"]
                on = _sys_name(dict(U.systems.get(other) or {}, id=other))
                st.append(_first(_story("%s between %s and %s right now" % (_bps_text(bps), nm, on), "rate", 1),
                                 _story("%s between %s and %s" % (_bps_text(bps), nm, on), "rate", 1)))
    if kind == "site":
        anchor = U.bodies.get(s.get("anchor")) or {}
        rtts = [_num((b.get("m") or {}).get("rtt_ms")) for b in ([anchor] if anchor in bs else bs)]
        rtts = sorted(r for r in rtts if r is not None and r > 0)
        if rtts and (anchor.get("status") == "up" or any(b.get("status") == "up" for b in bs)):
            st.append(_story("%s ms round trip to %s" % (_fmt(rtts[len(rtts) // 2]), nm), "rate", 2))
    return _stories(st)


def _cat_story(bs, cat, nm):
    """One guest category of a Proxmox host (the blk:<hub>:<cat> stop)."""
    word, title = _CAT_WORD.get(cat), _CAT_TITLE.get(cat)
    if not word:
        return []
    up = [b for b in bs if b.get("status") == "up"]
    st = []
    bps = sum((_num((b.get("m") or {}).get("rx_bps")) or 0) + (_num((b.get("m") or {}).get("tx_bps")) or 0) for b in up)
    if bps >= LINK_MIN_BPS:
        st.append(_first(_story("%s on %s moving %s right now" % (title, nm, _bps_text(bps)), "rate", 1),
                         _story("%s on %s moving %s" % (title, nm, _bps_text(bps)), "rate", 1),
                         _story("%s on %s \u00b7 %s" % (title, nm, _bps_text(bps)), "rate", 1)))
    if up:
        st.append(_first(
            _story("%d of %d %s guests running on %s" % (len(up), len(bs), word, nm), "count", 1) if len(up) < len(bs) else None,
            _story("%d of %d %s guests up on %s" % (len(up), len(bs), word, nm), "count", 1) if len(up) < len(bs) else None,
            _story("%d %s %s running on %s" % (len(up), word, "guest" if len(up) == 1 else "guests", nm), "count", 1),
            _story("%d %s %s on %s" % (len(up), word, "guest" if len(up) == 1 else "guests", nm), "count", 1)))
    return _stories(st)


def build_systems(U, now):
    """[{id: "sys:<x>", story: [...], cats: {<cat>: [...]}}] for every system with at least
    one candidate. `cats` only on Proxmox hosts, only for categories of >= 3 guests."""
    out = []
    for sid, s in U.systems.items():
        st = _sys_story(U, sid, now)
        row = {"id": sid, "story": st}
        if str(s.get("kind") or "") == "pvehost":
            nm = _sys_name(dict(s, id=sid))
            by = {}
            for b in U.bodies.values():
                if b.get("system") == sid and _is_guest(b) and not b.get("lab") and b.get("down_why") != "gone":
                    by.setdefault(str(b.get("cat") or "infra"), []).append(b)
            cats = {}
            for cat, bs in sorted(by.items()):
                cs = _cat_story(bs, cat, nm) if len(bs) >= CAT_MIN else []
                if cs:
                    cats[cat] = cs
            if cats:
                row["cats"] = cats
        if st or row.get("cats"):
            out.append(row)
    return out


def build_links(U, now):
    """[{a, b, story}] per measured system-to-system stream, strongest first (the stream stop)."""
    if not _traffic_fresh(U, now):
        return []
    out = []
    for bps, p in sorted(_pairs(U), key=lambda x: -x[0]):
        if bps < LINK_MIN_BPS:
            continue
        a, b = p["a"], p["b"]
        na, nb = _sys_name(dict(U.systems[a], id=a)), _sys_name(dict(U.systems[b], id=b))
        st = [_first(_story("%s between %s and %s right now" % (_bps_text(bps), na, nb), "rate", 1),
                     _story("%s between %s and %s" % (_bps_text(bps), na, nb), "rate", 1),
                     _story("%s \u00b7 %s and %s" % (_bps_text(bps), na, nb), "rate", 1))]
        ab, ba = _num(p.get("a_to_b_bps")), _num(p.get("b_to_a_bps"))
        if ab is not None and ba is not None and min(ab, ba) >= 1e3:
            st.append(_first(_story("%s %s to %s · %s back" % (_bps_text(ab), na, nb, _bps_text(ba)), "rate", 2),
                             _story("%s to %s · %s back" % (_bps_text(ab), nb, _bps_text(ba)), "rate", 2)))
        st = _stories(st)
        if st:
            out.append({"a": a, "b": b, "story": st})
    return out[:12]


def build_estate(U, now):
    """Candidates for the two overviews: the whole estate in one measured line."""
    if not U.known:
        return []
    bs = [b for b in _live(list(U.bodies.values())) if b.get("class") != "edge"]   # the ISP is not a device
    st = []
    if _traffic_fresh(U, now):
        tot = sum(bps for bps, _ in _pairs(U))
        if tot >= LINK_MIN_BPS:
            st.append(_first(_story("%s moving across the estate right now" % _bps_text(tot), "rate", 1),
                             _story("%s across the estate right now" % _bps_text(tot), "rate", 1),
                             _story("%s moving across the estate" % _bps_text(tot), "rate", 1)))
    hosts = sum(1 for b in bs if b.get("class") == "pve_host" and b.get("status") == "up")
    # "on N hosts" counts the Proxmox hosts, so only their guests (a cluster's pods are not on them)
    pve = {sid for sid, s in U.systems.items() if str(s.get("kind") or "") == "pvehost"}
    ct, vm = _guest_split([b for b in bs if b.get("system") in pve])
    if hosts and (ct or vm):
        st.append(_guests_text(ct, vm, "on %s" % _plural(hosts, "host")))
    # no "N of M devices online" here: the overview caption under this line counts every body the
    # registry knows (bench gear and long-gone ones too), and two different totals on one screen
    # read as a mistake
    return _stories(st)


def _k8s_parts(U, now):
    """asp:k8s (one per configured cluster, after the last host stop) and the
    clusters' rows for the shared problem list. Empty without k8s.py or clusters."""
    try:
        import k8s
        if not k8s.REGISTRY.snapshots():
            return [], []
        return k8s.tour_aspects(U, now=now), k8s.tour_problems(U, now=now)
    except Exception as e:                     # optional feed: never take the tour down
        print(f"[tour] k8s failed: {type(e).__name__}: {e}", flush=True)
        return [], []


# ------------------------------------------------------------------ flask --
_cache = {"at": 0.0, "body": None}
_lock = threading.Lock()
_uni_parsed = {"src": None, "uni": Uni(None)}


def _universe_now():
    try:
        import universe
        raw = (getattr(universe, "_cache", None) or {}).get("body")
    except Exception:
        raw = None
    if raw is None:
        return _uni_parsed["uni"]
    if raw is not _uni_parsed["src"]:
        try:
            _uni_parsed.update(src=raw, uni=Uni(json.loads(raw) if isinstance(raw, (str, bytes)) else raw))
        except Exception:
            pass
    return _uni_parsed["uni"]


def _show_now(DATA=None):
    if config.DEMO and isinstance((DATA or {}).get("showtime"), dict):
        # demo mode serves the showtime snapshot from DATA; it is always "just polled"
        return dict(DATA["showtime"], polled={k: time.time() for k in ("ollama", "emby", "frigate", "gpu_series")})
    try:
        import showtime
        with showtime._lock:
            return dict(showtime.SHOW, polled=dict(showtime.SHOW.get("polled") or {}))
    except Exception:
        return None


def install(app, DATA):
    from flask import Response

    @app.route("/api/tour")
    def api_tour():
        now = time.time()
        if _cache["body"] is None or now - _cache["at"] >= CACHE_S:
            with _lock:
                if _cache["body"] is None or time.time() - _cache["at"] >= CACHE_S:
                    res = build(DATA, _universe_now(), _show_now(DATA), now=time.time())
                    _cache["body"] = json.dumps(res, separators=(",", ":"), ensure_ascii=False)
                    _cache["at"] = time.time()
        return Response(_cache["body"], mimetype="application/json", headers={"Cache-Control": "no-store"})

    return api_tour
