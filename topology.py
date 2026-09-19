#!/usr/bin/env python3
"""Real network topology + live traffic poller for the Homelab GALAXY dashboard.

Produces DATA["topology"]: a truthful tree of the physical/logical network
(wan -> gateway -> switches/APs -> PVE hosts -> guests, plus UniFi clients) with
MEASURED throughput on every edge that can actually be measured:

  * Proxmox : /cluster/resources?type=vm -> cumulative netin/netout per guest
              (queried on every configured endpoint and merged), differenced
              across samples; each guest's own config for its static IP / MAC.
  * UniFi   : stat/device -> physical uplink tree (uplink.uplink_mac) plus
              cumulative uplink/port byte counters (differenced);
              stat/sta    -> per-client instant rates (rx_bytes-r/tx_bytes-r)
              and which switch port / AP each client AND each PVE host hangs
              off (sw_mac/sw_port, ap_mac);
              stat/health -> WAN instant rates, wan_ip, isp, status;
              rest/user   -> every client the controller has ever seen, so a
              named host that is asleep is drawn as DOWN, not silently gone.
  * Frigate : camera count annotation for the (unmeasured) remote NVR edge.
  * ntopng  : real host-to-host conversations sniffed on the capture bridge
              (sees guest-to-guest traffic that never touches the physical
              switch). Active-flow cumulative bytes are differenced across
              samples into bits/sec and emitted as DATA["topology"]["flows"]
              + ["flow_meta"]. Runs in its OWN daemon thread on its own
              cadence; if ntopng is down the rest of the topology is unaffected.
  * probe   : (optional) measured RTT/jitter/loss per node and hosts found by
              the subnet sweep that no controller lists.
  * netmap  : (optional) SNMP devices LibreNMS knows that nothing else here does.

HONEST-DATA RULES
  - Every rate is a real measurement. Where a rate cannot be measured (first
    sample, counter reset/wrap, backend down, stale cache) the node/link is
    emitted with measured=false and rx/tx/bps = 0 -- the renderer must not
    animate flow on those.
  - Pair-wise host-to-host conversations are ONLY emitted when ntopng has
    actually seen them AND two successive samples of the same flow exist (so
    the rate is a true measurement, never a guess). A flow that
    disappears/reappears or whose byte counter resets skips that interval
    instead of spiking. First-sample flows are withheld until measurable.
    Edges in `links` remain physical/logical links only.
  - Counter resets/wraps (new < old) skip that interval instead of spiking.
  - VMs/LXCs that UniFi sees as wired "clients" bridged through a PVE host's
    switch port are suppressed from the client list (they are already guest
    nodes) -- detected physically: same sw_mac/sw_port as a PVE host.

Every source except Proxmox is optional: with no UniFi the tree is
wan -> PVE hosts -> guests, still with measured guest rates.

Cadence: rates every FAST_S (5s); slow structure (device uplink tree, PVE
host port attachment, Frigate camera meta) rebuilt every SLOW_S (60s);
ntopng flows every FLOW_S (5s) in their own thread.

Import as a module and call start_topology_poller(DATA) with app.py's DATA
dict. Secrets come only from config; nothing is hardcoded or logged.
"""
import ipaddress
import re
import threading
import time

import requests

import config
import pollers

try:
    import urllib3
    urllib3.disable_warnings()
except Exception:
    pass

DATA = {}
PVE_NODES = pollers.pve_nodes            # a function: discovered from the configured endpoints
UNIFI = config.UNIFI_URL
UNIFI_USER, UNIFI_PASS, UNIFI_SITE = config.UNIFI_USER, config.UNIFI_PASS, config.UNIFI_SITE or "default"
FRIGATE = config.FRIGATE_URL
categorize = config.categorize

# When a node id was first observed. "Has anything new appeared?" is a
# question this dashboard could not answer at all before -- every poll looked
# identical whether a container was ten seconds or ten months old.
_first_seen = {}
_boot = time.time()
BASELINE_S = 90          # everything present in the first 90 s after start is
                         # the baseline, not an arrival -- otherwise a service
                         # restart flags the entire estate as brand new
NEW_S = 900              # a node counts as newly-appeared for this long
NEW_GRACE_S = 1800       # ...and is exempt from CLIENT_CAP for this long, so a
                         # quiet new device cannot be culled before it is seen

NVR_IP = config.NVR_IP                    # optional camera NVR on another site
FAST_S = 5                # rate sampling interval (seconds)
SLOW_S = 60               # structure rebuild interval (seconds)
EMA_A = 2.0 / (3 + 1)     # light EMA over ~3 samples: smooth, never invented
CLIENT_CAP = config.TOPOLOGY_CLIENT_CAP   # ANONYMOUS clients (no UniFi name, no hostname, wireless)
                                          # beyond the busiest N may be dropped when idle...
IDLE_BPS = 8000.0         # ...idle = slower than this (bits/sec). Named, wired or
                          # curated clients are NEVER culled.
OFFLINE_KEEP_S = 3 * 86400   # a named client UniFi has seen this recently but that
                             # is not associated right now (asleep / powered off)
                             # stays on the map as status "down" -- present, not lost
KNOWN_S = 300             # refresh the UniFi known-client list (rest/user) this often

# ---- client classification: meta.cat for the front end ----
# Override map: mac or ip -> (cat, label-or-None), built from config
# (TOPOLOGY_CLIENT_OVERRIDES / config.json topology.client_overrides). Each
# entry may carry alt_macs: a multi-NIC machine that answers on several MACs
# is then drawn once, under one label. Anything not here is derived from the
# UniFi name/hostname, then the OUI vendor string.
CLIENT_OVERRIDES = {}
for _o in config.TOPOLOGY_CLIENT_OVERRIDES:
    if not isinstance(_o, dict):
        continue
    _val = (str(_o.get("cat") or "unknown"), (str(_o["label"]) if _o.get("label") else None))
    for _k in [_o.get("mac"), _o.get("ip"), *(_o.get("alt_macs") or [])]:
        if _k:
            CLIENT_OVERRIDES[str(_k).lower()] = _val

_CAT_NAME = [   # (cat, substrings matched against lower-cased name/hostname) -- first hit wins
    ("3dprinter",  ["ender", "prusa", "bambu", "creality", "3dprint", "k1max", "k1 max"]),
    ("printer",    ["printer", "deskjet", "officejet", "laserjet", "brother", "epson", "canon"]),
    ("phone",      ["iphone", "pixel", "galaxy", "android", "oneplus", "phone", "ipad"]),
    ("av",         ["roku", "tv", "chromecast", "shield", "firetv", "fire-tv", "appletv", "apple-tv",
                    "sonos", "hdhr", "tuner", "echo", "soundbar", "denon", "receiver"]),
    ("smart-home", ["aqara", "hue", "elgato", "espressif", "esp-", "esp_", "shelly", "tasmota", "sonoff",
                    "tuya", "wemo", "kasa", "govee", "lifx", "mysimplelink",
                    "smartthings", "homepod", "tapo", "wled"]),
    ("appliance",  ["midea", "net_ac", "washer", "dryer", "dishwasher", "fridge", "lg_", "whirlpool",
                    "thermostat", "ecobee", "ups"]),
    ("network",    ["tp link", "tp-link", "deco", "netgear", "udm", "unifi", "ubnt", "cisco", "switch",
                    "router", "idrac", "ipmi", "ilo", "starlink", "usw", "uap", "ont", "gateway"]),
    ("pc",         ["windows", "desktop-", "laptop", "macbook", "imac", "fedora", "ubuntu",
                    "minipc", "mini pc", "thinkpad", "surface", "-pc", "pc-", "workstation"]),
]
_CAT_OUI = [    # (cat, substrings matched against the lower-cased OUI vendor string)
    ("av",         ["roku", "amazon", "google", "sonos", "vizio", "lg electronics", "sony"]),
    ("smart-home", ["signify", "philips", "lumi", "dexatek", "espressif", "shelly", "tuya", "sonoff", "texas instruments"]),
    ("appliance",  ["midea", "schneider", "apc", "whirlpool", "haier", "samsung electronics co.,ltd"]),
    ("network",    ["netgear", "tp-link", "ubiquiti", "cisco", "juniper", "aruba", "mikrotik"]),
    ("3dprinter",  ["creality", "bambu", "prusa"]),
    ("printer",    ["hewlett", "brother", "epson", "canon"]),
    ("pc",         ["asrock", "asustek", "micro-star", "gigabyte", "intel", "liteon", "dell", "lenovo",
                    "framework", "realtek", "hp inc"]),
]


def _client_cat(name, hostname, oui, wired, mac=None, ip=None):
    """meta.cat for a client node: override map, then name/hostname patterns,
    then the UniFi OUI vendor string. Returns (cat, label_override_or_None)."""
    for key in (str(mac or "").lower(), str(ip or "")):
        if key and key in CLIENT_OVERRIDES:
            return CLIENT_OVERRIDES[key]
    n = f"{name or ''} {hostname or ''}".strip().lower()
    if n:
        for cat, keys in _CAT_NAME:
            if any(k in n for k in keys):
                return cat, None
    o = (oui or "").lower()
    if o:
        if o.startswith("apple"):
            return ("pc" if wired else "phone"), None
        if o.startswith("samsung"):
            return ("av" if wired else "phone"), None
        for cat, keys in _CAT_OUI:
            if any(k in o for k in keys):
                return cat, None
    return "unknown", None


# ---- ntopng (host-to-host flows sniffed on the capture bridge) ----
NTOPNG_URL = config.NTOPNG_URL
NTOPNG_USER = config.NTOPNG_USER
NTOPNG_PASS = config.NTOPNG_PASS
NTOPNG_IFNAME = config.NTOPNG_IFNAME      # capture interface to resolve
NTOPNG_IFID_FALLBACK = config.NTOPNG_IFID or None   # used only if discovery fails
FLOW_S = 5                   # flow sampling interval (seconds), own thread
FLOW_PER_PAGE = 200          # active flows fetched per sample (top by bytes)
FLOW_TOP = 30                # always keep the busiest N flows by bps...
FLOW_KEEP_INT_BPS = 50_000.0 # ...plus every LAN-to-LAN flow above this (bits/sec)
FLOW_STATE_CAP = 4096        # bound on per-flow counter state (clear = skip one interval)
IFID_TTL = 600               # re-discover the capture ifid this often (seconds)

# ---------------- rate math: cumulative-counter differencing + light EMA ----------------
_prev = {}   # counter key -> (ts, value)          (cumulative counters)
_ema = {}    # key -> smoothed rate, units/sec


def _smooth(key, raw):
    """EMA over ~3 samples so the visual doesn't jitter. Input is a REAL rate."""
    try:
        raw = float(raw)
    except (TypeError, ValueError):
        return None
    e = _ema.get(key)
    e = raw if e is None else EMA_A * raw + (1.0 - EMA_A) * e
    _ema[key] = e
    return e


def _rate(key, value, now):
    """Difference a CUMULATIVE byte counter against its previous sample.
    Returns EMA-smoothed bytes/sec, or None when genuinely unknown (first
    sample, counter reset/wrap, bad clock) -- caller must set measured=false.
    A reset (new < old) skips the interval instead of emitting a huge spike."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    prev = _prev.get(key)
    _prev[key] = (now, value)
    if prev is None:
        return None
    dt = now - prev[0]
    if dt <= 0:
        return None
    if value < prev[1]:                 # counter reset / wrap
        _ema.pop(key, None)
        return None
    return _smooth(key, (value - prev[1]) / dt)


# same math, but private state for the flow thread so the two pollers never
# clear each other's counters (flow keys churn much faster than link keys)
_fprev = {}   # flow key -> (ts, cumulative bytes)
_fema = {}    # flow key -> smoothed bytes/sec


def _fsmooth(key, raw):
    try:
        raw = float(raw)
    except (TypeError, ValueError):
        return None
    e = _fema.get(key)
    e = raw if e is None else EMA_A * raw + (1.0 - EMA_A) * e
    _fema[key] = e
    return e


def _frate(key, value, now):
    """Flow-thread twin of _rate(): first sample and counter reset (a flow that
    ended and restarted between samples) both return None -> that interval is
    skipped, never spiked."""
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    prev = _fprev.get(key)
    _fprev[key] = (now, value)
    if prev is None:
        return None
    dt = now - prev[0]
    if dt <= 0:
        return None
    if value < prev[1]:                 # flow disappeared and came back reset
        _fema.pop(key, None)
        return None
    return _fsmooth(key, (value - prev[1]) / dt)


# Display aliases for UniFi device names (config.json topology.aliases). The
# Network API refuses to rename the console device itself, so the wall name can
# be set here; renaming it in the UniFi OS console would make it authoritative.
NAME_ALIASES = {str(k): str(v) for k, v in config.TOPOLOGY_ALIASES.items()}


def _alias(name):
    return NAME_ALIASES.get(name, name)


def _rnd(v, nd=1):
    return None if v is None else round(v, nd)


# ---------------- data sources ----------------
# Per-node last-good guest lists: one node being unreachable must not read as
# "those guests were deleted".
_pve_last, _pve_err = {}, {}
_pve_state = {"stale_nodes": []}


def _pve_guests():
    """Every guest with cumulative netin/netout.

    Standalone Proxmox hosts each answer /cluster/resources with only THEIR
    guests, so every configured endpoint is queried and merged (a real cluster
    returns the same set from each node; (node, vmid) keys dedupe it).
    Returns None only if NO node answered."""
    out, ok = [], False
    seen = set()
    stale_nodes = []
    for n in PVE_NODES():
        name = n["node"]
        fresh, node_guests = False, []
        try:
            r = requests.get(f"{n['url']}/api2/json/cluster/resources?type=vm",
                             headers={"Authorization": f"PVEAPIToken={n['token']}"},
                             verify=False, timeout=5)
            # an expired token returns 401 with no "data" key, which used to be
            # indistinguishable from "this node has zero guests" -- so a dead
            # token silently deleted half the estate. Check the status first.
            if r.status_code != 200:
                raise RuntimeError(f"HTTP {r.status_code}")
            data = r.json().get("data")
            if data is None:
                raise RuntimeError("no data field in response")
            fresh = True
            for g in data:
                g.setdefault("node", name)
                node_guests.append(g)
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:140]
            if _pve_err.get(name) != msg:      # log on change, not every 5 s
                print(f"[topology] pve {name}: {msg}", flush=True)
                _pve_err[name] = msg
        if fresh:
            _pve_last[name] = node_guests
            if _pve_err.pop(name, None):
                print(f"[topology] pve {name}: recovered", flush=True)
            ok = True
        else:
            # THIS node is unreachable -- serve its last-good guests rather than
            # letting the other node's healthy answer look like the whole estate
            node_guests = [dict(g, _stale=True) for g in (_pve_last.get(name) or [])]
            if node_guests:
                stale_nodes.append(name)
        for g in node_guests:
            key = (g.get("node") or name, g.get("vmid"))
            if key in seen:
                continue
            seen.add(key)
            out.append(g)
    _pve_state["stale_nodes"] = stale_nodes
    return out if (ok or out) else None


_us = None


def _unifi_get(path, timeout=6):
    global _us
    if not UNIFI:
        raise RuntimeError("UniFi not configured")
    if _us is None:
        s = requests.Session()
        s.post(f"{UNIFI}/api/auth/login",
               json={"username": UNIFI_USER, "password": UNIFI_PASS},
               verify=False, timeout=timeout)
        _us = s
    r = _us.get(f"{UNIFI}/proxy/network/api/s/{UNIFI_SITE}/{path}", verify=False, timeout=timeout)
    data = r.json().get("data", [])
    if not data:      # expired session: the controller returns empty data, no exception
        _us = None
    return data


def _pve_ips():
    """management ip -> PVE node name, from the shared inventory."""
    return pollers.pve_node_ips()


# ---------------- slow structural pass (every SLOW_S) ----------------
_struct = {"dev_parent": {}, "pve_attach": {}, "gateway_mac": None,
           "frigate_guest": None, "cameras": None, "built": 0}
_known = {"rows": [], "at": 0.0}     # UniFi rest/user (every client ever seen), refreshed every KNOWN_S


def _rebuild(devices, stas, guests):
    """Who is plugged into whom -- from uplink_mac / sw_mac+sw_port. Real data only."""
    s = {"dev_parent": {}, "pve_attach": {}, "gateway_mac": None,
         "frigate_guest": None, "cameras": _struct.get("cameras"), "built": time.time()}
    macs = set()
    for d in devices:
        mac = (d.get("mac") or "").lower()
        if not mac:
            continue
        macs.add(mac)
        # UDM / UXG / USG / UDR all serve as the gateway; matching only "udm"
        # would orphan the entire tree when the gateway model changes
        if (d.get("type") or "").lower().startswith(("udm", "uxg", "ugw", "usg", "udr")):
            s["gateway_mac"] = mac
    if not s["gateway_mac"]:
        # unknown gateway model: the root is the device whose uplink points
        # outside the fleet (or has none at all)
        for d in devices:
            mac = (d.get("mac") or "").lower()
            up = ((d.get("uplink") or {}).get("uplink_mac") or "").lower()
            if mac and (not up or up not in macs):
                s["gateway_mac"] = mac
                print(f"[topology] gateway inferred from uplink: {mac} ({d.get('type')})", flush=True)
                break
    for d in devices:
        mac = (d.get("mac") or "").lower()
        if not mac:
            continue
        up = ((d.get("uplink") or {}).get("uplink_mac") or "").lower()
        if mac == s["gateway_mac"]:
            s["dev_parent"][mac] = "wan"
        elif up and up in macs:
            s["dev_parent"][mac] = f"unifi:{up}"
        elif s["gateway_mac"]:
            s["dev_parent"][mac] = f"unifi:{s['gateway_mac']}"   # uplink unknown: hang off gateway
        else:
            s["dev_parent"][mac] = None
    pve_ip = _pve_ips()
    for c in stas:            # PVE hosts appear in stat/sta as wired clients -> real port
        name = pve_ip.get(c.get("ip"))
        if name and c.get("sw_mac"):
            s["pve_attach"][name] = {"sw_mac": c["sw_mac"].lower(), "port": c.get("sw_port")}
    for g in guests or []:
        if "frigate" in (g.get("name") or "").lower():
            s["frigate_guest"] = f"guest:{g.get('node')}:{g.get('vmid')}"
            break
    if FRIGATE:
        try:      # camera count annotation for the remote NVR edge (best effort, real only)
            st = requests.get(f"{FRIGATE}/api/stats", timeout=5).json()
            s["cameras"] = len(st.get("cameras") or {})
        except Exception:
            pass
    return s


# ---------------- fast assembly pass (every FAST_S) ----------------

# ---- guest IP resolution -------------------------------------------------
# /cluster/resources carries no IP, so guest nodes would be emitted with ip=None
# and every guest-to-guest ntopng flow would land unmapped. Each guest's own
# PVE config does carry it (netN ip=...) for statically addressed guests. DHCP
# guests are resolved by MAC against the UniFi client table, or stay unmapped.
# Never guessed. Refreshed every GIP_TTL since addresses rarely change.
_gip, _gip_ts = {}, 0.0
_gip_miss = {}        # (node,vmid) -> last attempt, so an unresolvable guest
GIP_TTL = 600         # is retried on a slow beat instead of every 5 s tick
GIP_RETRY = 120
_NET_IP = re.compile(r"\bip=(\d+\.\d+\.\d+\.\d+)")
_NET_MAC = re.compile(r"\b([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})\b")

_gmac = {}                              # vmid -> lowercased MAC (DHCP guests)
_gwip, _gwip_ts = [], 0.0


def _gateway_ips():
    """Every LAN gateway address the controller owns, straight from UniFi's
    network config (`ip_subnet` = that network's gateway). Cached for GIP_TTL."""
    global _gwip, _gwip_ts
    if not UNIFI:
        return []
    now = time.time()
    if _gwip and now - _gwip_ts < GIP_TTL:
        return _gwip
    out = []
    try:
        for n in (_unifi_get("rest/networkconf") or []):
            sub = n.get("ip_subnet")
            if not isinstance(sub, str) or "/" not in sub:
                continue
            ip = sub.split("/", 1)[0].strip()
            try:
                ipaddress.ip_address(ip)
            except ValueError:
                continue
            out.append(ip)
    except Exception:
        return _gwip
    if out:
        _gwip, _gwip_ts = out, now
    return _gwip


def _guest_ip_map(guests):
    """vmid -> static IP from the guest's own PVE config. Also records vmid ->
    MAC as a side channel so DHCP guests can be resolved against the UniFi
    client table, which is the only place their address is known."""
    global _gip, _gip_ts, _gmac
    now = time.time()
    by_node = {n["node"]: n for n in PVE_NODES()}
    full = (not _gip and not _gmac) or (now - _gip_ts >= GIP_TTL)

    # A brand-new guest must not wait out the whole TTL before it has an IP or
    # MAC. Resolve anything never seen immediately; everything else on the TTL.
    todo = []
    for g in guests or []:
        vmid, node = g.get("vmid"), g.get("node")
        if vmid is None or node not in by_node:
            continue
        key = (node, vmid)
        if full or (key not in _gip and key not in _gmac
                    and now - _gip_miss.get(key, 0) >= GIP_RETRY):
            todo.append(g)
    if not todo:
        return _gip

    out = {} if full else dict(_gip)
    macs = {} if full else dict(_gmac)
    for g in todo:
        vmid, node = g.get("vmid"), g.get("node")
        n = by_node.get(node)
        if vmid is None or n is None:
            continue
        kind = "lxc" if str(g.get("type") or "").lower() in ("lxc", "ct") else "qemu"
        try:
            r = requests.get(
                f"{n['url']}/api2/json/nodes/{node}/{kind}/{vmid}/config",
                headers={"Authorization": f"PVEAPIToken={n['token']}"},
                verify=False, timeout=5)
            cfg = r.json().get("data") or {}
        except Exception:
            _gip_miss[(node, vmid)] = now
            continue                      # one bad guest must not poison the map
        got = False
        # every netN, not just the first few: an address on net3+ would be invisible
        for k in sorted(k for k in cfg if k.startswith("net") and k[3:].isdigit()):
            v = cfg.get(k)
            if not isinstance(v, str):
                continue
            # record the MAC ALWAYS, not only when there is no static IP: it is
            # the identity the UniFi client table is keyed on, and it is what
            # stops a bridged guest being drawn a second time as a client
            mm = _NET_MAC.search(v)
            if mm and (node, vmid) not in macs:
                macs[(node, vmid)] = mm.group(1).lower()
            m = _NET_IP.search(v)
            if m and not got:
                out[(node, vmid)] = m.group(1)
                got = True
        if got or (node, vmid) in macs:
            _gip_miss.pop((node, vmid), None)
        else:
            _gip_miss[(node, vmid)] = now
    if out or macs:                       # keep the last good map on total failure
        _gip, _gmac = out, macs
        if full:
            _gip_ts = now
    return _gip


def _build(devices, stas, wan, guests, now, unifi_fresh, pve_fresh, health_fresh):
    global _ipmap
    nodes, links, node_ids = [], [], set()
    ipmap = {}          # ip -> {"id": node id, "label": label}; consumed by the flow thread

    probe = (DATA.get("probe") or {})
    prtt = probe.get("rtt") or {}
    parp = probe.get("arp") or {}

    def add(nid, kind, label, ip, parent, rx, tx, status, meta=None):
        if nid in node_ids:
            return
        node_ids.add(nid)
        m = {k: v for k, v in (meta or {}).items() if v is not None}
        seen = _first_seen.setdefault(nid, now)
        if seen - _boot > BASELINE_S and now - seen < NEW_S:
            m["new"] = True
            m["age"] = round(now - seen)
        # measured reachability, when the prober has an answer for this address.
        # Absent means "not probed yet"; loss 100 with no rtt means "did not
        # answer" -- neither is ever reported as a latency of zero.
        r = prtt.get(str(ip)) if ip else None
        if r:
            if r.get("rtt") is not None:
                m["rtt"] = r["rtt"]
                m["jitter"] = r.get("jitter")
            m["loss"] = r.get("loss")
        # A host that answers ARP but not ICMP is ALIVE with a firewall, not
        # down (Windows drops echo by default). Say so explicitly rather than
        # silently flipping the number.
        if ip and str(ip) in parp and r and r.get("loss") == 100:
            m["icmp_silent"] = True
            m["mac"] = parp[str(ip)]
        nodes.append({"id": nid, "kind": kind, "label": label, "ip": ip, "parent": parent,
                      "rx": round(rx, 1) if rx is not None else 0.0,
                      "tx": round(tx, 1) if tx is not None else 0.0,
                      "measured": rx is not None and tx is not None,
                      "status": status, "meta": m})
        if ip:
            ipmap.setdefault(str(ip), {"id": nid, "label": label})

    def link(src, dst, rx, tx, cap):
        links.append({"source": src, "target": dst,
                      "bps": round(((rx or 0.0) + (tx or 0.0)) * 8.0, 1),
                      "measured": rx is not None and tx is not None,
                      "capacity_bps": int(cap) if cap else None})

    # ---- synthetic WAN root, rates from stat/health (instant, already bytes/sec) ----
    wan_rx = _smooth("wan.rx", wan.get("rx_bytes-r") or 0) if health_fresh else None
    wan_tx = _smooth("wan.tx", wan.get("tx_bytes-r") or 0) if health_fresh else None
    wst = wan.get("status") or wan.get("uplink_status") or ""
    # The address this node carries is what the prober measures and what the
    # hover card calls the internet's latency, so it has to be a host that is
    # actually OUT there. `wan_ip` is not: it is this estate's OWN address on
    # the gateway's WAN interface. UniFi's health payload names the real next
    # hop in `gateways`; discovered, so swapping the ISP router needs no edit.
    upstream = next((g for g in (wan.get("gateways") or []) if g), None)
    wmeta = {"isp": wan.get("isp_name")}
    if wan.get("wan_ip"):
        wmeta["wan_ip"] = wan.get("wan_ip")      # still true, just not the ISP's
    # The gateway continuously pings real internet targets. That IS the
    # internet's latency; the next hop's sub-millisecond is not. Reported only
    # when UniFi has it - an absent monitor stays absent rather than becoming a zero.
    ust = (wan.get("uptime_stats") or {}).get("WAN") or {}
    if health_fresh and ust.get("latency_average") is not None:
        wmeta["inet_ms"] = round(float(ust["latency_average"]), 1)
    if health_fresh and ust.get("availability") is not None:
        wmeta["inet_avail"] = round(float(ust["availability"]), 1)
    # Cloudflare tunnel edge summary (edge.py). The wan node IS this estate's
    # internet edge, so the tunnel facts live here.
    cf = ((DATA.get("edge") or {}).get("cloudflare") or {}) if isinstance(DATA.get("edge"), dict) else {}
    if cf:
        wmeta["cloudflare"] = {k: cf.get(k) for k in
                               ("up", "ha_connections", "req_per_min", "err_per_min",
                                "locations", "active_streams", "connect_latency_ms_p50", "ts")}
    add("wan", "wan", wan.get("isp_name") or config.WAN_LABEL or "Internet", upstream, None,
        wan_rx, wan_tx, "up" if wst == "ok" else ("down" if health_fresh and wst else "unknown"),
        wmeta)

    # ---- UniFi devices: the real physical tree ----
    dev_by_mac = {}
    for d in devices or []:
        mac = (d.get("mac") or "").lower()
        if mac:
            dev_by_mac[mac] = d
    gw_mac = _struct.get("gateway_mac") or next(
        (m for m, d in dev_by_mac.items() if (d.get("type") or "").startswith("udm")), None)
    gw_id = f"unifi:{gw_mac}" if gw_mac else None

    ports = {}                       # (sw_mac, port_idx) -> port_table entry
    for mac, d in dev_by_mac.items():
        for p in d.get("port_table") or []:
            if p.get("port_idx") is not None:
                ports[(mac, p["port_idx"])] = p

    for mac, d in dev_by_mac.items():
        nid = f"unifi:{mac}"
        t = d.get("type") or ""
        kind = "gateway" if t.startswith("udm") or mac == gw_mac else "ap" if t.startswith("uap") else "switch"
        parent = _struct.get("dev_parent", {}).get(mac) or ("wan" if kind == "gateway" else gw_id)
        up = d.get("uplink") or {}
        cap = (up.get("speed") or 0) * 1_000_000 or None
        rx = tx = None
        if kind == "gateway":
            for gip in _gateway_ips():       # the gateway address in each routed VLAN -> this node
                ipmap.setdefault(gip, {"id": nid, "label": _alias(d.get("name") or "Gateway")})
            rx, tx = wan_rx, wan_tx          # the gateway's uplink IS the WAN
            if rx is None and unifi_fresh and up.get("rx_bytes") is not None:
                rx = _rate(f"devup.{mac}.rx", up.get("rx_bytes"), now)
                tx = _rate(f"devup.{mac}.tx", up.get("tx_bytes"), now)
        elif unifi_fresh:
            if up.get("rx_bytes") is not None:       # cumulative uplink counters -> difference
                rx = _rate(f"devup.{mac}.rx", up.get("rx_bytes"), now)
                tx = _rate(f"devup.{mac}.tx", up.get("tx_bytes"), now)
            else:                                    # fall back to the is_uplink port counters
                upp = next((p for p in d.get("port_table") or [] if p.get("is_uplink")), None)
                if upp and upp.get("rx_bytes") is not None:
                    rx = _rate(f"devport.{mac}.rx", upp.get("rx_bytes"), now)
                    tx = _rate(f"devport.{mac}.tx", upp.get("tx_bytes"), now)
                    cap = cap or (upp.get("speed") or 0) * 1_000_000 or None
        status = "up" if d.get("state") == 1 else ("down" if unifi_fresh else "unknown")
        add(nid, kind, _alias(d.get("name") or d.get("model") or mac), d.get("ip"), parent,
            rx, tx, status, {"model": d.get("model")})
        if parent:
            link(parent, nid, rx, tx, cap)

    # ---- PVE hosts: attach to their REAL switch port (matched by ip in stat/sta) ----
    sta_by_ip = {c.get("ip"): c for c in stas or [] if c.get("ip")}
    pve_ip = _pve_ips()
    guests_by_node = {}
    for g in guests or []:
        guests_by_node.setdefault(g.get("node"), []).append(g)
    pve_ports = set()                # (sw_mac, port) taken by PVE hosts -> bridged-guest dedupe

    # a cluster answers on one address for several node names: every node still
    # gets its own galaxy, keyed on the name
    host_names = dict(pve_ip)
    for n in PVE_NODES():
        if n["node"] not in host_names.values():
            host_names[f"{n['node']}@{n['url']}"] = n["node"]
    for ip, name in host_names.items():
        ip = ip if ip in pve_ip else None
        nid = f"pve:{name}"
        att = _struct.get("pve_attach", {}).get(name) or {}
        sw_mac, port = att.get("sw_mac"), att.get("port")
        c = sta_by_ip.get(ip) if ip else None
        if not sw_mac and c and c.get("sw_mac"):
            sw_mac, port = c["sw_mac"].lower(), c.get("sw_port")
        if sw_mac and port is not None:
            pve_ports.add((sw_mac, port))
        parent = f"unifi:{sw_mac}" if sw_mac and f"unifi:{sw_mac}" in node_ids else \
                 (gw_id if gw_id in node_ids else "wan")
        rx = tx = None
        if c and unifi_fresh:        # UniFi sta rates are from the switch's perspective:
            rx = _smooth(f"pve.{name}.rx", c.get("tx_bytes-r") or 0)   # tx->client = INTO host
            tx = _smooth(f"pve.{name}.tx", c.get("rx_bytes-r") or 0)   # rx from client = OUT of host
        gl = guests_by_node.get(name, [])
        status = "up" if (c or (pve_fresh and gl)) else "unknown"
        add(nid, "pvehost", name, ip, parent, rx, tx, status,
            {"port": port, "guests": len(gl),
             "running": sum(1 for g in gl if g.get("status") == "running")})
        # the host's switch PORT carries host + all bridged guest traffic -> honest link rate
        lrx = ltx = lcap = None
        p = ports.get((sw_mac, port)) if sw_mac else None
        if p:
            lcap = (p.get("speed") or 0) * 1_000_000 or None
            if unifi_fresh and p.get("rx_bytes") is not None:
                lrx = _rate(f"port.{sw_mac}.{port}.rx", p.get("rx_bytes"), now)
                ltx = _rate(f"port.{sw_mac}.{port}.tx", p.get("tx_bytes"), now)
        if parent:
            link(parent, nid, lrx, ltx, lcap)

    # ---- guests: netin/netout differenced from /cluster/resources ----
    guest_count = 0
    guest_ips = dict(_guest_ip_map(guests))
    if _gmac:                             # DHCP guests: MAC -> IP via UniFi
        sta_ip = {}
        for c in stas or []:
            mc = (c.get("mac") or "").lower()
            if mc and c.get("ip"):
                sta_ip[mc] = str(c["ip"])
        for gk, mc in _gmac.items():
            if gk not in guest_ips and mc in sta_ip:
                guest_ips[gk] = sta_ip[mc]
    guest_by_name = {}               # lowercased guest name -> node id (for flow ip mapping)
    for g in guests or []:
        vmid = g.get("vmid")
        if vmid is None:
            continue
        nm = (g.get("name") or "").strip().lower()
        if nm:
            guest_by_name.setdefault(nm, f"guest:{g.get('node')}:{vmid}")
        guest_count += 1
        gnode = g.get("node")
        nid = f"guest:{gnode}:{vmid}"
        pnode = f"pve:{g.get('node')}"
        parent = pnode if pnode in node_ids else None
        name = g.get("name") or str(vmid)
        running = g.get("status") == "running"
        if not pve_fresh:
            rx = tx = None; status = "unknown"        # stale cache: shape only, no rates
        elif not running:
            rx = tx = 0.0; status = "down"            # genuinely idle: measured zero
        else:
            rx = _rate(f"guest.{gnode}.{vmid}.rx", g.get("netin"), now) if g.get("netin") is not None else None
            tx = _rate(f"guest.{gnode}.{vmid}.tx", g.get("netout"), now) if g.get("netout") is not None else None
            status = "up"
        add(nid, "guest", name, guest_ips.get((gnode, vmid)), parent, rx, tx, status,
            {"cat": categorize(name), "type": g.get("type"), "vmid": vmid,
             "cpu": round(g.get("cpu", 0) * 100, 1) if running else None,
             "mem_pct": round(g.get("mem", 0) / max(g.get("maxmem", 1), 1) * 100, 1) if running else None,
             # what the guest is actually doing right now: disk I/O differenced
             # from cumulative counters, same honesty rule as every other rate
             "disk_pct": (round(g.get("disk", 0) / max(g.get("maxdisk", 1), 1) * 100, 1)
                          if running and g.get("maxdisk") else None),
             "dr": _rnd(_rate(f"guest.{gnode}.{vmid}.dr", g.get("diskread"), now)
                        if running and g.get("diskread") is not None else None),
             "dw": _rnd(_rate(f"guest.{gnode}.{vmid}.dw", g.get("diskwrite"), now)
                        if running and g.get("diskwrite") is not None else None),
             "up": g.get("uptime") if running else None})
        if parent:
            link(parent, nid, rx, tx, None)

    # ---- clients: instant sta rates; cap to the busiest + anything non-idle ----
    cand = []
    for c in stas or []:
        mac = (c.get("mac") or "").lower()
        if not mac or c.get("ip") in pve_ip:
            continue                                  # PVE hosts already emitted above
        sw_mac = (c.get("sw_mac") or "").lower()
        if c.get("is_wired") and (sw_mac, c.get("sw_port")) in pve_ports:
            # guest bridged via a PVE host port -> already a guest node; but its IP
            # is only known HERE, so map it for the flow thread when the UniFi
            # hostname exactly matches a guest name (real correlation, no guessing)
            gname = (c.get("name") or c.get("hostname") or "").strip().lower()
            gnid = guest_by_name.get(gname)
            if gnid is not None and c.get("ip"):
                ipmap.setdefault(str(c["ip"]), {"id": gnid, "label": c.get("name") or c.get("hostname")})
            continue
        rx = _smooth(f"sta.{mac}.rx", c.get("tx_bytes-r") or 0)   # switch-perspective, see pvehost note
        tx = _smooth(f"sta.{mac}.tx", c.get("rx_bytes-r") or 0)
        cand.append((((rx or 0) + (tx or 0)) * 8.0, mac, c, rx, tx))
    cand.sort(key=lambda t: -t[0])
    client_count, shown, culled = len(cand), 0, 0
    online_macs = set()
    online_curated = set()   # override labels already drawn as UP (multi-NIC machines)
    for i, (thr, mac, c, rx, tx) in enumerate(cand):
        # Cull policy: a real host is never dropped for being quiet. Only an
        # ANONYMOUS client -- no UniFi name, no hostname, not wired, not in the
        # override map -- that is idle AND past the busiest-N AND not newly
        # seen may go. Everything a person could point at stays.
        name, hostname = (c.get("name") or "").strip(), (c.get("hostname") or "").strip()
        wired = bool(c.get("is_wired"))
        cseen = _first_seen.get(f"client:{mac}", now)
        fresh = (cseen - _boot > BASELINE_S) and (now - cseen) < NEW_GRACE_S
        anonymous = not (name or hostname or wired or mac in CLIENT_OVERRIDES
                         or str(c.get("ip") or "") in CLIENT_OVERRIDES)
        if anonymous and i >= CLIENT_CAP and thr <= IDLE_BPS and not fresh:
            culled += 1
            continue
        shown += 1
        online_macs.add(mac)
        pm = ((c.get("sw_mac") if wired else c.get("ap_mac")) or "").lower()
        parent = f"unifi:{pm}" if f"unifi:{pm}" in node_ids else (gw_id if gw_id in node_ids else None)
        cap = None
        if wired:
            p = ports.get((pm, c.get("sw_port")))
            if p:
                cap = (p.get("speed") or 0) * 1_000_000 or None
        cat, lbl = _client_cat(name, hostname, c.get("oui"), wired, mac, c.get("ip"))
        if lbl and mac in CLIENT_OVERRIDES:
            online_curated.add(lbl)
        add(f"client:{mac}", "client", lbl or name or hostname or c.get("ip") or mac,
            c.get("ip"), parent, rx, tx, "up",
            {"wired": wired, "port": c.get("sw_port") if wired else None,
             "cat": cat, "vendor": (c.get("oui") or None), "hostname": hostname or None,
             "name": name or None, "mac": mac})
        if parent:
            link(parent, f"client:{mac}", rx, tx, cap)

    # ---- known-but-offline clients: present as DOWN, not silently gone -------
    # UniFi's rest/user is every client the controller has ever seen. A named
    # host that was associated within OFFLINE_KEEP_S but is not in stat/sta
    # right now is still a host in this estate; it gets its node back with
    # status "down" and no rates. Proxmox-OUI entries are guests (owned by the
    # PVE section) and are skipped. Several MACs sharing one label+IP collapse
    # to the most recently seen.
    offline = 0
    seen_lbl_ip = {}
    for u in sorted((_known.get("rows") or []), key=lambda u: -(u.get("last_seen") or 0)):
        mac = (u.get("mac") or "").lower()
        if not mac or mac in online_macs or f"client:{mac}" in node_ids:
            continue
        name, hostname = (u.get("name") or "").strip(), (u.get("hostname") or "").strip()
        if not (name or hostname):
            continue
        if "proxmox" in (u.get("oui") or "").lower():
            continue
        last = u.get("last_seen") or 0
        if now - last > OFFLINE_KEEP_S:
            continue
        uip = str(u.get("last_ip") or u.get("fixed_ip") or "") or None
        if uip and (uip in pve_ip or uip in ipmap):
            continue                                   # address already lives on another node
        gname = (name or hostname).lower()
        if guest_by_name.get(gname) is not None:
            continue                                   # a guest that is simply stopped
        wired = bool(u.get("is_wired"))
        cat, lbl = _client_cat(name, hostname, u.get("oui"), wired, mac, uip)
        label = lbl or name or hostname
        # A curated multi-NIC machine (alt_macs) that is UP on one interface
        # must not also be drawn asleep on another.
        if lbl and mac in CLIENT_OVERRIDES and lbl in online_curated:
            continue
        key = (label, uip)
        if key in seen_lbl_ip:
            continue
        seen_lbl_ip[key] = mac
        pm = (u.get("last_uplink_mac") or "").lower()
        parent = f"unifi:{pm}" if f"unifi:{pm}" in node_ids else (gw_id if gw_id in node_ids else None)
        add(f"client:{mac}", "client", label, uip, parent, None, None, "down",
            {"wired": wired, "cat": cat, "vendor": (u.get("oui") or None),
             "hostname": hostname or None, "name": name or None, "mac": mac,
             "offline": True, "last_seen": int(last),
             "offline_h": round((now - last) / 3600.0, 1)})
        if parent:
            link(parent, f"client:{mac}", None, None, None)
        offline += 1

    # ---- discovered: answers ICMP, but no controller lists it ----------------
    # UniFi only knows what associated with it and Proxmox only knows its own
    # guests, so a static-IP appliance or anything on a dumb switch is
    # invisible to both. The prober's subnet sweep finds it. Parent is the
    # gateway because that is genuinely all we know. The gateway answers on a
    # LAN address per VLAN, none of which is the node's `ip` (that carries its
    # WAN address), so those must not read as "unknown".
    gw_lan = set(_gateway_ips() or [])
    # LibreNMS as a name source: SNMP knows what these boxes are called, ICMP
    # only knows they exist.
    snmp = {}
    for d in ((DATA.get("netmap") or {}).get("devices") or []):
        dip = d.get("ip")
        if dip:
            snmp[str(dip)] = d
    for uip in (probe.get("unknown") or [])[:24]:
        if uip in ipmap or uip in pve_ip or uip in gw_lan:
            continue
        nid = f"disc:{uip}"
        sd = snmp.get(uip) or {}
        label = sd.get("name") or uip
        dcat, dlbl = _client_cat(sd.get("name"), None, None, None, None, uip)
        add(nid, "client", dlbl or label, uip,
            gw_id if gw_id in node_ids else None,
            None, None, "up",
            {"discovered": True, "wired": None, "cat": dcat,
             "snmp": True if sd else None,
             "group": sd.get("group")})
        if gw_id in node_ids:
            link(gw_id, nid, None, None, None)

    # ---- SNMP-only devices: LibreNMS knows them, nothing else here does ------
    # That includes every DOWN device - which is exactly when you want to see
    # it - plus anything on a subnet the sweep does not cover.
    snmp_added = 0
    for dv in ((DATA.get("netmap") or {}).get("devices") or []):
        if snmp_added >= 32:
            break
        dip = str(dv.get("ip") or "")
        if not dip or dip in ipmap or dip in pve_ip or dip in gw_lan:
            continue
        try:
            a = ipaddress.ip_address(dip)
            if a.is_loopback:
                continue
        except ValueError:
            continue
        nid = f"snmp:{dip}"
        if nid in node_ids:
            continue
        up = bool(dv.get("up"))
        scat, slbl = _client_cat(dv.get("name"), None, None, None, None, dip)
        add(nid, "client", slbl or dv.get("name") or dip, dip,
            gw_id if gw_id in node_ids else None,
            None, None, "up" if up else "down",
            {"snmp": True, "group": dv.get("group"), "wired": None, "cat": scat})
        if gw_id in node_ids:
            link(gw_id, nid, None, None, None)
        snmp_added += 1

    # ---- external NVR on another site: real edge, rate NOT measurable ----
    if NVR_IP:
        fg = _struct.get("frigate_guest")
        ext_parent = fg if fg in node_ids else (gw_id if gw_id in node_ids else "wan")
        ext_id = f"ext:nvr-{NVR_IP}"
        add(ext_id, "external", "Camera NVR (remote)", NVR_IP, ext_parent, None, None, "unknown",
            {"via": "wan", "cameras": _struct.get("cameras"),
             "note": "camera streams pulled by Frigate; per-flow rate not measurable"})
        link(ext_parent, ext_id, None, None, None)

    _ipmap = ipmap        # atomic swap; read-only in the flow thread

    lan_bps = sum(lk["bps"] for lk in links
                  if lk["measured"] and lk["source"] != "wan" and not lk["target"].startswith("ext:"))
    return {"ts": now, "nodes": nodes, "links": links,
            "totals": {"wan_rx_bps": round((wan_rx or 0) * 8, 1),
                       "wan_tx_bps": round((wan_tx or 0) * 8, 1),
                       "wan_measured": wan_rx is not None,
                       "lan_bps": round(lan_bps, 1),        # sum of measured LAN link bps
                       "guest_count": guest_count,
                       "client_count": client_count,        # all clients seen this tick
                       "clients_shown": shown,              # after the busiest-N + non-idle cap
                       "clients_capped": culled > 0,        # only anonymous idle ones ever are
                       "clients_culled": culled,
                       "clients_offline": offline,          # known-but-asleep, shown as down
                       "stale_nodes": list(_pve_state["stale_nodes"])}}


# ---------------- ntopng flows (own thread, never blocks the pollers above) ----------------
_ipmap = {}          # ip -> {"id": node id, "label": label}; rebuilt by _build each tick
_flows_out = {"flows": [],
              "flow_meta": {"up": False, "ifid": None, "flow_count": 0,
                            "shown": 0, "ts": 0, "error": "not polled yet" if NTOPNG_URL else "not configured"}}
_nt_if = {"ifid": None, "at": 0.0}     # cached capture ifid + discovery timestamp


def _nt_get(path, params=None, timeout=5):
    """GET an ntopng REST v2 endpoint. Auth comes only from config (never
    logged). Normalises the {"rsp":..,"rc":0} envelope: rsp may be a list OR a
    dict wrapping a "data" list -- both become a list."""
    if not NTOPNG_PASS:
        raise RuntimeError("NTOPNG_PASS not set")
    r = requests.get(f"{NTOPNG_URL}{path}", params=params or {},
                     auth=(NTOPNG_USER, NTOPNG_PASS), timeout=timeout)
    if r.status_code in (401, 403):
        raise RuntimeError(f"auth failed ({r.status_code})")
    r.raise_for_status()
    j = r.json()
    if j.get("rc") not in (None, 0):
        raise RuntimeError(f"ntopng rc={j.get('rc')} {j.get('rc_str')}")
    rsp = j.get("rsp")
    if isinstance(rsp, list):
        return rsp
    if isinstance(rsp, dict):
        d = rsp.get("data")
        if isinstance(d, list):
            return d
        return [rsp]
    return []


def _nt_ifid(now):
    """Resolve the ifid of the capture interface by name (do not assume),
    cached for IFID_TTL; falls back to the configured id if discovery fails."""
    if _nt_if["ifid"] is not None and now - _nt_if["at"] < IFID_TTL:
        return _nt_if["ifid"]
    ifid = NTOPNG_IFID_FALLBACK
    try:
        for it in _nt_get("/lua/rest/v2/get/ntopng/interfaces.lua"):
            if isinstance(it, dict) and it.get("ifname") == NTOPNG_IFNAME and it.get("ifid") is not None:
                ifid = int(it["ifid"])
                break
    except Exception:
        pass          # fall back; the flow request itself will surface real errors
    if ifid is None:
        raise RuntimeError(f"capture interface {NTOPNG_IFNAME!r} not found (set NTOPNG_IFID)")
    _nt_if["ifid"], _nt_if["at"] = ifid, now
    return ifid


def _endpoint(v):
    """(ip_or_name, display_name, port) from a flow's client/server field.
    Normally a dict {"ip":..,"name":..,"port":..}, but be defensive: it has
    been seen as a plain string ("1.2.3.4", "1.2.3.4:443", "host.tld")."""
    if isinstance(v, dict):
        ip = v.get("ip") or v.get("host") or v.get("name") or ""
        name = v.get("name") or v.get("host") or ip
        ip, name = str(ip).strip(), str(name).strip()
        if "@" in ip and ip.rsplit("@", 1)[1].isdigit():   # "1.2.3.4@10" vlan suffix
            ip = ip.rsplit("@", 1)[0]
        return ip, name, v.get("port")
    if isinstance(v, (str, int, float)):
        s, port = str(v).strip(), None
        if s.startswith("[") and "]:" in s:                # "[v6]:port"
            h, p = s.rsplit("]:", 1)
            if p.isdigit():
                s, port = h.lstrip("["), int(p)
        elif s.count(":") == 1:                            # "v4:port" / "name:port"
            h, p = s.rsplit(":", 1)
            if p.isdigit():
                s, port = h, int(p)
        if "@" in s and s.rsplit("@", 1)[1].isdigit():
            s = s.rsplit("@", 1)[0]
        return s, s, port
    return "", "", None


def _flow_bytes(f):
    """Cumulative byte total for a flow. Probe the shapes ntopng has produced:
    bytes (number), bytes {"total":..}, bytes_sent + bytes_rcvd."""
    b = f.get("bytes")
    if isinstance(b, dict):
        b = b.get("total", b.get("value"))
    if b is None:
        s, r = f.get("bytes_sent"), f.get("bytes_rcvd")
        if s is None and r is None:
            return None
        b = (s or 0) + (r or 0)
    try:
        return float(b)
    except (TypeError, ValueError):
        return None


def _flow_proto(f):
    """L7 application name if ntopng knows it, else the L4 proto, else None."""
    p = f.get("protocol")
    if isinstance(p, dict):
        for k in ("l7", "l7_proto", "application", "l4"):
            v = p.get(k)
            if v:
                return str(v)
    elif isinstance(p, str) and p:
        return p
    for k in ("l7proto", "l7_proto", "application", "ndpi"):
        v = f.get(k)
        if isinstance(v, str) and v:
            return v
    return None


def _is_local(ip):
    try:
        return ipaddress.ip_address(ip).is_private
    except ValueError:
        return False          # hostnames / garbage -> treat as external


def _geo_enrich(flows):
    """Best effort: stamp cc / as_name / asn on the EXTERNAL endpoint of a flow
    when Akvorado (edge.py) has seen that address in the last hour. Absent
    otherwise -- never guessed."""
    try:
        import edge
    except Exception:
        return
    for f in flows:
        if f.get("internal"):
            continue
        for side in ("src", "dst"):
            ip = f.get(f"{side}_ip")
            if not ip or _is_local(ip):
                continue
            g = edge.geo(ip)
            if g:
                if g.get("cc"):      f["cc"] = g["cc"]
                if g.get("as_name"): f["as_name"] = g["as_name"]
                if g.get("asn"):     f["asn"] = g["asn"]
                f["ext_side"] = side
                break


def _publish_flows(flows, meta):
    """Store the flow payload and patch it onto the live topology dict.
    _build() re-attaches it on every topology tick, so both paths agree."""
    _geo_enrich(flows)
    _flows_out["flows"] = flows
    _flows_out["flow_meta"] = meta
    t = DATA.get("topology")
    if isinstance(t, dict):
        t["flows"] = flows
        t["flow_meta"] = meta


def _flows_tick(now):
    """One flow sample: fetch active flows, difference cumulative bytes per
    stable flow key into a REAL bits/sec, aggregate per directed host pair,
    map endpoints onto existing topology node ids by ip, cap the payload."""
    ifid = _nt_ifid(now)
    rows = _nt_get("/lua/rest/v2/get/flow/active.lua",
                   {"ifid": ifid, "perPage": FLOW_PER_PAGE,
                    "sortColumn": "column_bytes", "sortOrder": "desc"})
    ipmap = _ipmap                       # snapshot; swapped atomically by _build
    agg = {}                             # (client_ip, server_ip) -> aggregate
    for f in rows:
        if not isinstance(f, dict):
            continue
        cip, cname, cport = _endpoint(f.get("client", f.get("cli")))
        sip, sname, sport = _endpoint(f.get("server", f.get("srv")))
        if not cip or not sip or cip == sip:
            continue
        total = _flow_bytes(f)
        if total is None:
            continue
        proto = _flow_proto(f)
        # stable per-flow key: endpoints + ports + app; differenced like _rate()
        key = f"{cip}|{cport}|{sip}|{sport}|{proto or ''}"
        bytes_s = _frate(key, total, now)          # bytes/sec; None = not yet measurable
        if bytes_s is None:
            continue                               # first sample / reset: skip, never guess
        bps = bytes_s * 8.0
        a = agg.setdefault((cip, sip),
                           {"bps": 0.0, "bytes": 0.0, "protos": {},
                            "cname": cname, "sname": sname})
        a["bps"] += bps
        a["bytes"] += total
        a["protos"][proto] = a["protos"].get(proto, 0.0) + bps

    flows = []
    for (cip, sip), a in agg.items():
        src, dst = ipmap.get(cip), ipmap.get(sip)
        proto, best = None, -1.0
        for p, v in a["protos"].items():
            if p is not None and v > best:
                proto, best = p, v
        flows.append({"src": src["id"] if src else None,
                      "dst": dst["id"] if dst else None,
                      "src_ip": cip, "dst_ip": sip,
                      "src_label": (src or {}).get("label") or (a["cname"] if a["cname"] != cip else None) or cip,
                      "dst_label": (dst or {}).get("label") or (a["sname"] if a["sname"] != sip else None) or sip,
                      "bps": round(a["bps"], 1),
                      "bytes": int(a["bytes"]),
                      "proto": proto,
                      "internal": _is_local(cip) and _is_local(sip),
                      "measured": True})
    flows.sort(key=lambda x: -x["bps"])
    kept = flows[:FLOW_TOP] + [x for x in flows[FLOW_TOP:]
                               if x["internal"] and x["bps"] >= FLOW_KEEP_INT_BPS]
    _publish_flows(kept, {"up": True, "ifid": ifid, "flow_count": len(rows),
                          "shown": len(kept), "ts": now, "error": None})


def _flows_once(now):
    """One guarded flow-poll iteration; an ntopng failure only downgrades
    flow_meta -- the rest of the topology is untouched and keeps working."""
    try:
        _flows_tick(now)
        if len(_fprev) > FLOW_STATE_CAP:   # bounded state; a clear skips one interval
            _fprev.clear(); _fema.clear()
    except Exception as e:
        last_ifid = _nt_if["ifid"]
        _nt_if["ifid"] = None              # re-discover the ifid on recovery
        msg = f"{type(e).__name__}: {e}"[:160]
        _publish_flows([], {"up": False, "ifid": last_ifid, "flow_count": 0,
                            "shown": 0, "ts": now, "error": msg})
        print("[flows]", msg, flush=True)  # never contains the password


def poll_flows():
    while True:
        try:
            _flows_once(time.time())
        except Exception:
            pass                           # _flows_once already guards; belt and braces
        time.sleep(FLOW_S)


# ---------------- poller thread ----------------
_last_guests = None
_last_devices = None
_last_stas = None
_last_slow = 0.0


def _tick(now):
    global _struct, _last_guests, _last_devices, _last_stas, _last_slow, _us
    guests = _pve_guests()
    pve_fresh = guests is not None
    if pve_fresh:
        _last_guests = guests
    else:
        guests = _last_guests or []

    devices = stas = wan = None
    if UNIFI:
        try:
            devices = _unifi_get("stat/device") or None
        except Exception as e:
            _us = None; print("[topology] unifi device:", e, flush=True)
        try:
            stas = _unifi_get("stat/sta") or None
        except Exception as e:
            _us = None; print("[topology] unifi sta:", e, flush=True)
        try:
            hp = _unifi_get("stat/health") or []
            wan = next((h for h in hp if h.get("subsystem") == "wan"), None)
        except Exception as e:
            _us = None; print("[topology] unifi health:", e, flush=True)

    unifi_fresh = devices is not None
    if unifi_fresh:
        _last_devices = devices
    else:
        devices = _last_devices or []      # keep the tree shape; rates go unmeasured

    # known-client list (rest/user) for the offline-but-present section; cached
    # on failure so a hiccup never makes every sleeping host vanish
    if unifi_fresh and now - _known["at"] >= KNOWN_S:
        try:
            rows = _unifi_get("rest/user") or None
            if rows is not None:
                _known["rows"] = rows
                _known["at"] = now
        except Exception as e:
            _known["at"] = now - KNOWN_S + 30      # retry in 30 s, keep the old list
            print("[topology] unifi rest/user:", e, flush=True)

    # devices have a last-good cache, and so do clients: one failed sta fetch
    # must not make every client node and link blink out and back
    if stas is not None:
        _last_stas = stas
    else:
        stas = _last_stas or []

    if (unifi_fresh or not UNIFI) and (now - _last_slow >= SLOW_S or not _struct.get("built")):
        _struct = _rebuild(devices, stas or [], guests)
        _last_slow = now

    topo = _build(devices, stas or [], wan or {}, guests, now,
                  unifi_fresh, pve_fresh, wan is not None)
    # attach the latest measured flows (their own thread keeps these current;
    # additive keys only -- nodes/links/totals are untouched)
    topo["flows"] = _flows_out["flows"]
    topo["flow_meta"] = _flows_out["flow_meta"]
    # outside-connection blocks (edge.py / threats.py); same objects as /api/all
    if isinstance(DATA.get("edge"), dict):
        topo["edge"] = DATA["edge"]
    if isinstance(DATA.get("external"), dict):
        topo["external"] = DATA["external"]
    DATA["topology"] = topo


def poll_topology():
    while True:
        try:
            _tick(time.time())
            if len(_prev) > 4096:          # bounded state; a clear just skips one interval
                _prev.clear(); _ema.clear()
        except Exception as e:
            print("[topology]", e, flush=True)
        time.sleep(FAST_S)


def start_topology_poller(data=None):
    """Launch the topology poller as a daemon thread, sharing app.py's DATA dict.
    Also launches the ntopng flow poller in its OWN daemon thread when ntopng is
    configured: if it is down, flows go empty with flow_meta.up=false and
    nothing else changes."""
    global DATA
    if data is not None:
        DATA = data
    DATA.setdefault("topology", None)
    threading.Thread(target=poll_topology, daemon=True, name="topology").start()
    if NTOPNG_URL:
        threading.Thread(target=poll_flows, daemon=True, name="topology-flows").start()
