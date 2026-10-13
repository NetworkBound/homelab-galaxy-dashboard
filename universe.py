#!/usr/bin/env python3
"""GET /api/universe -- one deduplicated registry of every device in the homelab,
with a stable, append-only layout (CONTRACTS.md section 1).

Nothing here polls anything. Every input is state other pollers already hold:

  * DATA["topology"]      topology.py's graph (UniFi devices + clients, Proxmox
                          hosts + guests, probe/SNMP discoveries, NVR, WAN).
  * topology._last_stas   the FULL UniFi station list from the same tick; the
                          graph drops wired stations bridged through a PVE host
                          port (they are guests) and may cull anonymous idle ones.
                          Stations matching no guest MAC become bodies here.
  * topology._known       UniFi rest/user (every client ever seen); named clients
                          seen within RETAIN_S come back as status "down".
  * topology._gmac        (node, vmid) -> MAC from the guests' own PVE config.
  * DATA["netmap"]        LibreNMS devices (the graph caps these at 32).
  * DATA["probe"]         ICMP sweep: unknown live hosts (graph caps at 24).
  * DATA["cameras"] + DATA["frigate"]   Frigate cameras by name, per-camera fps.
  * DATA["edge"]          Cloudflare tunnel summary -> the edge body.
  * topology._last_devices  UniFi stat/device: LLDP neighbours per port (switch
                          detection; see switch_pass).
  * DECLARED_PATH         operator-declared devices (unmanaged switches etc.).

Systems (one galaxy each): sys:core (the gateway, switches and APs), one
sys:<node> per Proxmox node, sys:home (every other client) and one sys:<site>
per remote site declared in UNIVERSE_SITES (config.py). Nothing site-specific
lives in this file: node names, sites, tunnels and lab gear all come from the
configuration.

Identity precedence: vm:<node>:<vmid> for Proxmox guests (MACs become aliases),
otherwise mac: > snmp:<chassis> > ip: > name:.
Once an id is issued it never changes: every key ever seen for a body is kept in
an alias table, so a device first seen by IP that later shows its MAC keeps its
ip: id. Shell, slot, system and first_seen are persisted in STORE_PATH (atomic
write: temp + fsync + rename, under a thread lock and an flock). A body that is
no longer reported keeps its slot for RETAIN_S (status "down"); only after that
is it dropped and its slot may be reused.

Honesty: a value that was not measured is ABSENT from `m`, never 0. A device that
is down is "down", not missing; if the feeds themselves are stale it is
"unknown", not down.

Also:
  * `short` on bodies and systems (CONTRACTS section 7): deterministic display
    names, unique inside a system, operator overrides in NAMES_PATH.
  * `traffic` (CONTRACTS section 6): measured inter-system traffic. A sampler
    thread differences cumulative counters the app already holds (UniFi port and
    client counters from topology's stat/device + stat/sta, the gateway WAN) and
    the ntopng flow rates, plus WireGuard tunnel interface rates read from Zabbix
    (SNMP) once a minute; everything is EWMA-smoothed per key and aggregated per
    system pair at build time. Unmeasured is absent, never 0.
"""
import fcntl
import ipaddress
import json
import math
import os
import re
import sys
import tempfile
import threading
import time
import urllib.request

import config

V = 1
_UDIR = config.get("UNIVERSE_DIR") or config.DATA_DIR
STORE_PATH = os.environ.get("UNIVERSE_STORE") or os.path.join(_UDIR, "universe_slots.json")
# Operator-declared "these are one device" groups, for identities no feed can tie
# together (e.g. a printer LibreNMS knows only by an old IP). Edited by hand:
#   {"groups": [{"canonical": "mac:..", "also": ["ip:..", "name:.."], "note": ".."}]}
SAME_PATH = os.environ.get("UNIVERSE_SAME") or os.path.join(_UDIR, "universe_same.json")
_same_cache = {"mtime": None, "map": {}}


def load_same(path=None):
    """{alias key -> canonical id}, re-read only when the file changes. A missing or
    broken file means no manual merges, never an error."""
    path = path or SAME_PATH
    try:
        mt = os.path.getmtime(path)
    except OSError:
        _same_cache.update(mtime=None, map={})
        return {}
    if mt != _same_cache["mtime"]:
        m = {}
        try:
            with open(path) as f:
                for g in (json.load(f).get("groups") or []):
                    c = g.get("canonical")
                    for k in g.get("also") or []:
                        if c and k and k != c:
                            m[k] = c
        except Exception as e:
            print(f"[universe] {path} unreadable, ignoring: {type(e).__name__}: {e}", flush=True)
            m = {}
        _same_cache.update(mtime=mt, map=m)
    return _same_cache["map"]


def apply_same(obs, same):
    """Fold every observation that carries an alias key into the observation that
    carries its canonical key, keeping the canonical one as the base so its label
    and identity win (absorb never lowers status). If the canonical device is not
    reported this build, the alias observations are left alone; resolve() still
    maps them onto the canonical body through the persisted alias table."""
    if not same:
        return obs
    canon = {}
    for o in obs:
        for k in o.keys():  # noqa: SIM118 - Obs.keys() is an id list, not a dict view
            if k in same.values():
                canon.setdefault(k, o)
    out = []
    for o in obs:
        # an ip: alias only ever folds an IP-only observation: a different MAC now
        # holding that old DHCP address is a different device (a switch that
        # inherited a printer's old lease was being folded into the printer)
        strong = o.strong()
        tgt = next((same[k] for k in o.keys() if k in same  # noqa: SIM118
                    and not (strong and k.startswith("ip:"))), None)
        base = canon.get(tgt)
        if base is not None and base is not o:
            live = o.status == "up" and base.status != "up"
            base.absorb(o)
            if live:
                # the canonical record is a stale feed entry (e.g. LibreNMS's old
                # address); the live sighting's address and measurements win
                base.ips = o.ips + [i for i in base.ips if i not in o.ips]
                base.m.update(o.m)
            continue
        out.append(o)
    return out


def merge_same_in_store(store, same):
    """Retire stored bodies that are declared aliases: their ids become aliases of
    the canonical body and their slots are freed at once (not held as `down`)."""
    changed = False
    bodies, alias = store["bodies"], store["alias"]
    for k, c in same.items():
        if c not in bodies:
            continue                       # canonical not minted yet; try again next build
        if k in bodies:
            del bodies[k]
            changed = True
        for ak in [ak for ak, v in alias.items() if v == k]:
            alias[ak] = c
            changed = True
        if alias.get(k) != c:
            alias[k] = c
            changed = True
    return changed
RETAIN_S = 30 * 86400        # offline bodies keep their slot this long
NEW_S = 600                  # body.new for this long after first sight
BASELINE_S = 120             # bodies seen within this long of store creation are baseline, not "new"
CACHE_S = 4.0                # built response is reused this long
PERSIST_EVERY_S = 60.0       # last_seen-only changes are flushed at most this often
FRESH_S = 60.0               # topology older than this -> feeds are stale

# ---- shared with static/universe_layout.js (tests assert parity) ----
SHELL_OF_CLASS = {
    "pve_host": 0, "gateway": 0,
    "switch": 1, "ap": 1, "network_device": 1, "edge": 1,
    "server": 2, "storage": 2,
    "guest_lxc": 3,
    "guest_vm": 4,
    "computer": 5, "game_console": 5,
    "phone": 6, "tablet": 6,
    "tv_av": 7,
    "iot": 8,
    "appliance": 9,
    "printer": 10,
    "camera": 11,
    "unknown": 12,
}
CLASSES = tuple(SHELL_OF_CLASS)


def hash32(s):
    """FNV-1a 32-bit over UTF-8 bytes. Identical to UNIVERSE_LAYOUT.hash32."""
    h = 0x811C9DC5
    for b in str(s).encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def shell_of(cls):
    return SHELL_OF_CLASS.get(cls, SHELL_OF_CLASS["unknown"])


# ---- systems ----------------------------------------------------------------
# Built from the configuration, never hardcoded: the network core, one galaxy per
# Proxmox node (in configured order, then any node a clustered endpoint reports),
# home, then every site in UNIVERSE_SITES. The order is the INITIAL slot order
# only; slots are persisted, and a system that appears later (a new Proxmox node)
# is appended without moving the others.
CORE_ACCENT, HOME_ACCENT = "#9b8cff", "#68d391"
SITE_ACCENTS = ("#fc8181", "#63b3ed", "#f6ad55", "#b794f4", "#4fd1c5")
_node_hint = []          # node names the running app knows (DATA["nodes"]); set by build_from_data


def _site_defs():
    """[(sys id, label, ip_network or None, accent)] from UNIVERSE_SITES."""
    out = []
    for i, st in enumerate(config.UNIVERSE_SITES or []):
        sid = "sys:" + re.sub(r"[^a-z0-9_-]", "-", str(st.get("id")).strip().lower())
        net = None
        if st.get("cidr"):
            try:
                net = ipaddress.ip_network(str(st["cidr"]).strip(), strict=False)
            except ValueError:
                print(f"[universe] site {sid}: bad cidr {st.get('cidr')!r}, ignored", flush=True)
        out.append((sid, str(st.get("label") or st.get("id")), net,
                    str(st.get("accent") or SITE_ACCENTS[i % len(SITE_ACCENTS)])))
    return out


def system_defs():
    """{sys id: {label, kind, accent, short}} in initial order (see above)."""
    defs = {"sys:core": {"label": "network core", "kind": "network", "accent": CORE_ACCENT, "short": "CORE"}}
    try:
        nodes = config.node_entries(_node_hint)
    except Exception:
        nodes = [{"id": n, "label": n.upper(), "accent": None} for n in _node_hint]
    for n in nodes:
        sid = "sys:" + n["id"]
        defs[sid] = {"label": n["id"], "kind": "pvehost", "accent": n.get("accent") or system_accent(sid),
                     "short": str(n.get("label") or n["id"]).upper()}
    defs["sys:home"] = {"label": "home", "kind": "clients", "accent": HOME_ACCENT, "short": "HOME"}
    for sid, label, _net, accent in _site_defs():
        defs.setdefault(sid, {"label": label, "kind": "site", "accent": accent, "short": label.upper()})
    return defs


def system_order():
    return list(system_defs())


def camera_system():
    """Where the NVR's cameras live: UNIVERSE_CAMERA_SITE, else the site whose CIDR
    holds the NVR address, else home (None = let system_for decide)."""
    sites = _site_defs()
    want = str(config.UNIVERSE_CAMERA_SITE or "").strip().lower()
    if want:
        for sid, _l, _n, _a in sites:
            if sid == "sys:" + want or sid == want:
                return sid
    if config.NVR_IP:
        for sid, _l, net, _a in sites:
            if net is not None and _in(config.NVR_IP, net):
                return sid
    return None

CAT_TO_CLASS = {"network": "network_device", "av": "tv_av", "appliance": "appliance",
                "smart-home": "iot", "phone": "phone", "pc": "computer",
                "3dprinter": "printer", "printer": "printer", "unknown": "unknown"}
CLASS_TO_CAT = {"pve_host": "infra", "gateway": "network", "switch": "network", "ap": "network",
                "network_device": "network", "edge": "network", "server": "infra",
                "storage": "infra", "computer": "web", "phone": "web", "tablet": "web",
                "tv_av": "media", "game_console": "media", "iot": "infra", "appliance": "infra",
                "camera": "monitor", "printer": "infra", "unknown": "infra",
                "guest_lxc": "infra", "guest_vm": "infra"}
_NAME_CLASS = [
    ("game_console", ["xbox", "playstation", "ps4", "ps5", "nintendo", "steamdeck", "steam-deck"]),
    ("tablet", ["ipad", "tablet", "kindle", "galaxy-tab", "galaxy tab"]),
    ("camera", ["reolink", "camera", "-cam", "cam-", "doorbell"]),
]
_OUI_CLASS = {"ec:71:db": "camera"}   # a camera vendor whose OUI UniFi fingerprints poorly
_GW_NAMES = ("udm", "unifi", "gateway", "uxg", "usg", "udr")
_GENERIC_LABELS = {"iphone", "ipad", "android", "localhost", "galaxy", "unknown", "espressif",
                   "pixel", "samsung", "macbook", "windows", "desktop"}


# ---- ghost guards ---------------------------------------------------------------
# Seen in production: the dashboard's LAN path dropped for a few minutes (gateway,
# a Proxmox node and the NMS all unreachable) and the controller then served a
# SHORT stat/sta list while clients re-associated. Strong bodies (MAC / vm:) went
# unobserved, DHCP guests lost their UniFi-derived IPs, the ICMP sweep reported
# those IPs as "unknown", and resolve() minted ~16 ip: bodies for devices it
# already knew, because a strong body's IP is (by design) never an alias key.
IP_CLAIM_S = 6 * 3600        # a strong body still "owns" an IP it showed this recently
DEGRADED_GRACE_S = 600.0     # after any degraded signal, stay cautious this long
STA_DIP = 0.92               # station list below this fraction of its 30-min max = short
STA_WINDOW_S = 1800.0
HUB_CLASSES = ("switch",)    # classes a detected device may be promoted into (re-shelled once)
# Operator-declared devices no feed can see (unmanaged switches, etc.). Edited by hand:
#   {"devices": [{"id": "declared:switch:garage", "label": "Garage switch", "class": "switch",
#                 "mac": "..", "ip": "..", "parent": "<body id or topo id>",
#                 "children_macs": [".."]}]}
DECLARED_PATH = os.environ.get("UNIVERSE_DECLARED") or os.path.join(_UDIR, "universe_declared.json")
_declared_cache = {"mtime": None, "list": []}


def is_laa(mac):
    """Locally administered (randomised/private) MAC: 2nd hex digit is 2, 6, A or E."""
    m = str(mac or "").lower()
    return len(m) >= 2 and m[1] in "26ae"


def _mac_int(mac):
    try:
        return int(str(mac).replace(":", "").replace("-", ""), 16)
    except ValueError:
        return None


def _looks_like_addr(label):
    s = str(label or "").strip().lower()
    if not s:
        return True
    try:
        ipaddress.ip_address(s)
        return True
    except ValueError:
        pass
    return len(s) == 17 and s.count(":") == 5


def _same_24(a, b):
    if not a or not b:
        return True
    try:
        return ipaddress.ip_network(f"{a}/24", strict=False) == ipaddress.ip_network(f"{b}/24", strict=False)
    except ValueError:
        return True


def load_declared(path=None):
    """Operator-declared devices, re-read only when the file changes. Missing or
    broken file = no declared devices, never an error."""
    path = path or DECLARED_PATH
    try:
        mt = os.path.getmtime(path)
    except OSError:
        _declared_cache.update(mtime=None, list=[])
        return []
    if mt != _declared_cache["mtime"]:
        out = []
        try:
            with open(path) as f:
                for d in (json.load(f).get("devices") or []):
                    if isinstance(d, dict) and isinstance(d.get("id"), str) and d["id"].strip():
                        out.append(d)
        except Exception as e:
            print(f"[universe] {path} unreadable, ignoring: {type(e).__name__}: {e}", flush=True)
            out = []
        _declared_cache.update(mtime=mt, list=out)
    return _declared_cache["list"]


# ---- switch detection ------------------------------------------------------------
# (tier, substrings of the lower-cased UniFi OUI vendor string)
#   A: vendors whose wired, non-PC kit on a home LAN is overwhelmingly switches
#   B: enterprise vendors that also make routers/APs/phones/servers -> need 1 more clue
#   C: consumer vendors (also routers, plugs, extenders) -> need a name or LLDP clue
SWITCH_VENDORS = (
    ("A", ("alcatel", "nokia", "adva optical", "arista", "extreme networks", "brocade", "allied telesis", "edgecore",
           "accton", "mellanox", "h3c")),
    ("B", ("cisco", "juniper", "aruba", "hewlett packard enterprise", "mikrotik", "routerboard",
           "ubiquiti", "meraki", "ruckus", "dell emc")),
    ("C", ("tp-link", "tp link", "netgear", "d-link", "zyxel", "linksys", "tenda", "buffalo")),
)
_SW_NAME = ("switch", "omniswitch", "catalyst", "procurve", "jetstream", "edgeswitch", "ex2200",
            "ex2300", "ex3300", "ex3400", "ex4", "ws-c", "c9200", "c9300", "c2960", "c3560",
            "c3750", "crs3", "css3", "cbs3", "sg350", "sg300", "sg250", "tl-sg", "gs108", "gs308",
            "gs724", "xs708", "usw", "sw-", "-sw")
_NOT_SW_SUB = ("r7900", "r8000", "nighthawk", "orbi", "deco", "archer", "fortigate", "pfsense",
               "opnsense", "starlink", "nintendo", "access point", "idrac", "ilo")
_NOT_SW_WORD = {"router", "firewall", "modem", "wap", "ap", "phone", "printer", "camera",
                "tv", "srx"}
CHASSIS_SPAN = 0x40          # MACs of one OUI this close together = one chassis
INFER_MIN = 3                # wired non-guest clients on one port -> something switches there


def vendor_tier(vendor):
    v = (vendor or "").lower()
    if not v:
        return None
    for tier, keys in SWITCH_VENDORS:
        if any(k in v for k in keys):
            return tier
    return None


def _vendor_short(vendor):
    v = (vendor or "").strip()
    for cut in (",", " Inc", " Systems", " Networks", " Technologies", " Corporation", " Co."):
        if cut in v:
            v = v.split(cut)[0]
    return v.strip() or "Network"


def _name_switchy(label):
    n = (label or "").lower()
    if not n or n in _GENERIC_LABELS or _looks_like_addr(n):
        return False
    return any(k in n for k in _SW_NAME) and "nintendo" not in n


def _name_not_switch(label):
    n = (label or "").lower()
    if not n or n in _GENERIC_LABELS or _looks_like_addr(n):
        return False
    if any(k in n for k in _NOT_SW_SUB):
        return True
    words = set("".join(ch if ch.isalnum() else " " for ch in n).split())
    return bool(words & _NOT_SW_WORD)


def _ip_ok(ip):
    try:
        a = ipaddress.ip_address(str(ip))
        return not a.is_loopback
    except ValueError:
        return False


def _in(ip, net):
    try:
        return ipaddress.ip_address(str(ip)) in net
    except ValueError:
        return False


def client_class(cat, name=None, mac=None, vendor=None, group=None):
    n = (name or "").lower()
    for cls, keys in _NAME_CLASS:
        if any(k in n for k in keys):
            return cls
    if mac and str(mac).lower()[:8] in _OUI_CLASS:
        return _OUI_CLASS[str(mac).lower()[:8]]
    if "reolink" in (vendor or "").lower():
        return "camera"
    if group == "host" and (cat in (None, "unknown")):
        return "server"
    cls = CAT_TO_CLASS.get(cat or "unknown", "unknown")
    if cls in ("phone", "tablet") and vendor_tier(vendor) in ("A", "B"):
        # an enterprise network-vendor MAC is never a phone, whatever UniFi's
        # fingerprint guessed from a DHCP hostname (a bench switch called "iPhone")
        cls = "network_device"
    return cls


# ---- observations -------------------------------------------------------------
class Obs:
    """One device as reported by one or more feeds during a single build."""
    __slots__ = ("macs", "vm", "snmp", "ips", "name", "label", "cls", "cat", "topo",
                 "parent_topo", "parent_obs", "status", "m", "src", "sys_hint", "pve_node",
                 "decl", "parent_ref", "hub", "merge_ok", "reclass_ok", "folded", "lab", "down_why")

    def __init__(self, label, cls, status="unknown", src=(), topo=None, mac=None, vm=None,
                 snmp=None, ip=None, name=None, cat=None, parent_topo=None, m=None,
                 sys_hint=None, pve_node=None, decl=None):
        # decl: a synthetic/declared id (inferred:switch:.., declared ids) that is the
        # body id when nothing stronger already names the device
        self.decl, self.parent_ref, self.hub = decl, None, False
        # lab: an operator-declared scratch Proxmox guest (PVE tag `lab` or
        # UNIVERSE_LAB_VMIDS, decided in topology/inventory; never inferred)
        self.lab = False
        # down_why: a feed's own reason for status "down" (offline | stopped), e.g. a
        # finished Kubernetes job is "stopped"; None = decided in build()
        self.down_why = None
        self.merge_ok = self.reclass_ok = self.folded = False
        self.macs = [mac.lower()] if mac else []
        self.vm, self.snmp, self.name = vm, snmp, name
        self.ips = [str(ip)] if ip and _ip_ok(ip) else []
        self.label, self.cls, self.cat, self.topo = label, cls, cat, topo
        self.parent_topo, self.parent_obs = parent_topo, None
        self.status = status
        self.m = {k: v for k, v in (m or {}).items() if v is not None}
        self.src = list(src)
        self.sys_hint, self.pve_node = sys_hint, pve_node

    def strong(self):
        return bool(self.macs or self.vm or self.snmp or self.decl)

    def keys(self):
        """Candidate ids in precedence order. A Proxmox guest is always vm:<node>:<vmid>
        (its MACs are aliases): a guest can have several NICs, a NIC can be
        recreated with a new MAC, and the MAC is unknown on a cold start. A guest
        migrated to another node gets a new id (accepted)."""
        out = []
        if self.decl:
            out.append(self.decl)
        if self.vm:
            out.append("vm:" + self.vm)
        out += ["mac:" + m for m in self.macs]
        if self.snmp:
            out.append("snmp:" + self.snmp)
        out += ["ip:" + i for i in self.ips]
        if self.name:
            out.append("name:" + self.name)
        return out

    def absorb(self, o):
        for mac in o.macs:
            if mac not in self.macs:
                self.macs.append(mac)
        for ip in o.ips:
            if ip not in self.ips:
                self.ips.append(ip)
        self.vm = self.vm or o.vm
        self.decl = self.decl or o.decl
        self.parent_ref = self.parent_ref or o.parent_ref
        self.hub = self.hub or o.hub
        self.lab = self.lab or o.lab
        self.down_why = self.down_why or o.down_why
        self.merge_ok = self.merge_ok or o.merge_ok
        self.reclass_ok = self.reclass_ok or o.reclass_ok
        self.snmp = self.snmp or o.snmp
        self.name = self.name or o.name
        self.topo = self.topo or o.topo
        self.parent_topo = self.parent_topo or o.parent_topo
        self.parent_obs = self.parent_obs or o.parent_obs
        self.sys_hint = self.sys_hint or o.sys_hint
        self.pve_node = self.pve_node or o.pve_node
        if (not self.label or self.label == (self.ips[0] if self.ips else None)) and o.label:
            self.label = o.label
        if self.cls == "unknown" and o.cls != "unknown":
            self.cls, self.cat = o.cls, o.cat
        rank = {"up": 3, "idle": 2, "down": 1, "unknown": 0}
        if rank.get(o.status, 0) > rank.get(self.status, 0):
            self.status = o.status
        for k, v in o.m.items():
            self.m.setdefault(k, v)
        for s in o.src:
            if s not in self.src:
                self.src.append(s)


class Merger:
    """Within-build dedupe: same MAC or vm = same device; same IP merges only when
    it cannot join two different strong identities."""

    def __init__(self):
        self.items, self.by_mac, self.by_vm, self.by_ip, self.by_name = [], {}, {}, {}, {}

    def find(self, o):
        for mac in o.macs:
            if mac in self.by_mac:
                return self.by_mac[mac]
        if o.vm and o.vm in self.by_vm:
            return self.by_vm[o.vm]
        if o.name and o.name in self.by_name:
            return self.by_name[o.name]
        for ip in o.ips:
            g = self.by_ip.get(ip)
            if g is None:
                continue
            # two different MACs/vms behind one IP are two devices
            if o.macs and g.macs and not set(o.macs) & set(g.macs):
                continue
            if o.vm and g.vm and o.vm != g.vm:
                continue
            return g
        return None

    def add(self, o):
        g = self.find(o)
        if g is None:
            self.items.append(o)
            g = o
        else:
            g.absorb(o)
        self._index(g)
        return g

    def _index(self, g):
        for mac in g.macs:
            self.by_mac.setdefault(mac, g)
        if g.vm:
            self.by_vm.setdefault(g.vm, g)
        if g.name:
            self.by_name.setdefault(g.name, g)
        for ip in g.ips:
            self.by_ip.setdefault(ip, g)

    def by_topo(self):
        return {g.topo: g for g in self.items if g.topo}


def _metrics_from_node(n):
    meta = n.get("meta") or {}
    m = {}
    if n.get("measured"):
        if n.get("rx") is not None:
            m["rx_bps"] = round(float(n["rx"]) * 8.0, 1)
        if n.get("tx") is not None:
            m["tx_bps"] = round(float(n["tx"]) * 8.0, 1)
    if meta.get("rtt") is not None:
        m["rtt_ms"] = meta["rtt"]
    if meta.get("loss") is not None:
        m["loss"] = meta["loss"]
    if meta.get("cpu") is not None:
        m["cpu"] = round(float(meta["cpu"]) / 100.0, 4)
        m["cpu_pct"] = meta["cpu"]
    for k in ("mem_pct", "disk_pct", "wired", "vendor", "model", "vmid", "type",
              "hostname", "icmp_silent"):
        if meta.get(k) is not None:
            m[k] = meta[k]
    if meta.get("jitter") is not None:
        m["jitter_ms"] = meta["jitter"]
    if n.get("ip"):
        m["ip"] = n["ip"]
    if meta.get("mac"):
        m["mac"] = meta["mac"]
    return m


def observe(topo, all_data, gw_lan=(), stas=None, known=None, gmac=None,
            client_cat=None, now=None, excluded=None, devices=None, declared=None,
            same=None):
    """Turn already-fetched feed state into merged observations.

    topo: DATA["topology"] dict. all_data: dict with netmap/probe/cameras/frigate/edge.
    stas/known/gmac: topology module internals (in-process only; None in tests and demo mode).
    client_cat: topology._client_cat when available.
    """
    now = now or time.time()
    M = Merger()
    cam_sys = camera_system()
    nodes = (topo or {}).get("nodes") or []
    gmac = gmac or {}
    gw_lan = set(gw_lan or [])
    guest_mac = {}                         # mac -> (node, vmid)
    for (node, vmid), mac in gmac.items():
        guest_mac[str(mac).lower()] = (node, vmid)
    vm_mac = {f"{node}:{vmid}": mac for mac, (node, vmid) in guest_mac.items()}
    sta_by_ip = {}
    for c in stas or []:
        if c.get("ip"):
            sta_by_ip[str(c["ip"])] = c
    gw_topo = None
    switch_topo = None
    pve_topo = {}

    # 1) topology graph: the deduped spine
    for n in nodes:
        nid, kind, meta = n.get("id"), n.get("kind"), n.get("meta") or {}
        st = n.get("status") or "unknown"
        m = _metrics_from_node(n)
        src = []
        if kind == "wan":
            o = Obs(n.get("label") or "Internet", "edge", st, ["unifi"], topo=nid,
                    name="internet", cat="network", m=m)
            for k in ("isp", "inet_ms", "inet_avail", "wan_ip"):
                if meta.get(k) is not None:
                    o.m[k] = meta[k]
            M.add(o)
            continue
        if kind in ("gateway", "switch", "ap"):
            mac = nid.split(":", 1)[1] if nid.startswith("unifi:") else None
            if mac is None and nid.startswith("snmp:") and _mac_int(meta.get("chassis_id") or "") is not None:
                mac = str(meta["chassis_id"]).lower()      # an SNMP-polled switch (snmp.py): chassis MAC
            o = Obs(n.get("label"), kind, st, ["unifi"], topo=nid, mac=mac, ip=n.get("ip"),
                    cat="network", parent_topo=n.get("parent"), m=m, sys_hint="sys:core")
            if kind == "gateway":
                gw_topo = gw_topo or nid
            if kind == "switch":
                switch_topo = switch_topo or nid
            M.add(o)
            continue
        if kind == "pvehost":
            node = nid.split(":", 1)[1]
            pve_topo[node] = nid
            c = sta_by_ip.get(str(n.get("ip")))
            mac = (c.get("mac") or "").lower() if c else None
            o = Obs(n.get("label") or node, "pve_host", st, ["proxmox"] + (["unifi"] if c else []),
                    topo=nid, mac=mac or None, ip=n.get("ip"), name="pve:" + node, cat="infra",
                    parent_topo=n.get("parent"), m=m, sys_hint="sys:" + node, pve_node=node)
            M.add(o)
            continue
        if kind == "guest":
            _, node, vmid = nid.split(":", 2)
            vm = f"{node}:{vmid}"
            cls = "guest_lxc" if str(meta.get("type") or "").lower() in ("lxc", "ct") else "guest_vm"
            o = Obs(n.get("label"), cls, st, ["proxmox"], topo=nid, vm=vm,
                    mac=vm_mac.get(vm), ip=n.get("ip"), cat=meta.get("cat") or "infra",
                    parent_topo=n.get("parent"), m=m, sys_hint="sys:" + node, pve_node=node)
            o.lab = bool(meta.get("lab"))
            M.add(o)
            continue
        if kind == "external":
            # a remote camera NVR (NP_NVR_IP): it lives at the camera site when one is declared
            o = Obs(n.get("label"), "storage", st, ["frigate"], topo=nid, ip=n.get("ip"),
                    cat="monitor", parent_topo=n.get("parent"), m=m, sys_hint=cam_sys)
            if meta.get("cameras") is not None:
                o.m["cameras"] = meta["cameras"]
            M.add(o)
            continue
        # clients (UniFi online/offline, probe discoveries, SNMP-only)
        mac = meta.get("mac") if nid.startswith("client:") else None
        if nid.startswith("lldp:") and _mac_int(nid[5:]) is not None:
            mac = nid[5:].lower()           # an LLDP-only neighbour: its chassis MAC is its identity
            src = ["lldp"]
        if nid.startswith("client:"):
            src = ["unifi"]
        elif nid.startswith("disc:"):
            src = ["probe"]
        elif nid.startswith("snmp:"):
            src = ["snmp"]
        if meta.get("snmp") and "snmp" not in src:
            src.append("snmp")
        if meta.get("offline"):
            m["offline_h"] = meta.get("offline_h")
        cls = client_class(meta.get("cat"), n.get("label"), mac, meta.get("vendor"), meta.get("group"))
        o = Obs(n.get("label"), cls, st, src, topo=nid, mac=mac, ip=n.get("ip"),
                cat=CLASS_TO_CAT.get(cls, "infra"), parent_topo=n.get("parent"), m=m)
        M.add(o)

    topo_ids = {n.get("id") for n in nodes}
    by_topo = M.by_topo()

    # 2) full UniFi station list (in-process): what the graph left out
    pve_ports = set()
    for c in stas or []:
        if (str(c.get("ip") or "") in {str(n.get("ip")) for n in nodes if n.get("kind") == "pvehost"}
                and c.get("sw_mac")):
                pve_ports.add(((c.get("sw_mac") or "").lower(), c.get("sw_port")))
    pve_by_port = {}
    for c in stas or []:
        for n in nodes:
            if n.get("kind") == "pvehost" and str(n.get("ip")) == str(c.get("ip")) and c.get("sw_mac"):
                pve_by_port[((c.get("sw_mac") or "").lower(), c.get("sw_port"))] = n["id"].split(":", 1)[1]
    # wired clients: UniFi leaves the instant *-r rates empty/0 for most of them, but their
    # cumulative wired-*_bytes counters are differenced in TrafficState (key ("sta", mac),
    # bits/s, counter perspective = the switch's). Fresh keys only; absent stays absent.
    try:
        _tsnap = _traffic.snapshot(time.time())[0]
    except Exception:
        _tsnap = {}
    for c in stas or []:
        mac = (c.get("mac") or "").lower()
        if not mac:
            continue
        rx, tx = c.get("tx_bytes-r"), c.get("rx_bytes-r")    # switch perspective, inverted
        m = {"wired": bool(c.get("is_wired"))}
        if rx is not None:
            m["rx_bps"] = round(float(rx) * 8.0, 1)
        if tx is not None:
            m["tx_bps"] = round(float(tx) * 8.0, 1)
        ce = (_tsnap.get(("sta", mac)) or {}).get("e") if m["wired"] else None
        if ce is not None and len(ce) != 2:
            ce = None
        if ce and not (m.get("rx_bps") or m.get("tx_bps")):
            m["rx_bps"], m["tx_bps"] = round(ce[1], 1), round(ce[0], 1)   # [from client, to client]
        if c.get("oui"):
            m["vendor"] = c["oui"]
        if c.get("ip"):
            m["ip"] = str(c["ip"])
        m["mac"] = mac
        if mac in M.by_mac:
            g = M.by_mac[mac]
            if "unifi" not in g.src:
                g.src.append("unifi")
            if ce and not (g.m.get("rx_bps") or g.m.get("tx_bps")):   # topology measured it as 0: the counters know better
                g.m["rx_bps"], g.m["tx_bps"] = m["rx_bps"], m["tx_bps"]
            if c.get("ip") and str(c["ip"]) not in g.ips and _ip_ok(c["ip"]):
                g.ips.append(str(c["ip"]))
            continue
        if mac in guest_mac:
            node, vmid = guest_mac[mac]
            g = M.by_vm.get(f"{node}:{vmid}")
            if g is not None:
                g.macs.append(mac)
                if "unifi" not in g.src:
                    g.src.append("unifi")
                M._index(g)
                continue
        name, host = (c.get("name") or "").strip(), (c.get("hostname") or "").strip()
        wired = bool(c.get("is_wired"))
        sw = (c.get("sw_mac") or "").lower()
        bridged_node = pve_by_port.get((sw, c.get("sw_port"))) if wired else None
        if client_cat:
            try:
                cat, lbl = client_cat(name, host, c.get("oui"), wired, mac, c.get("ip"))
            except Exception:
                cat, lbl = "unknown", None
        else:
            cat, lbl = "unknown", None
        label = lbl or name or host or c.get("ip") or mac
        cls = client_class(cat, label, mac, c.get("oui"))
        if bridged_node:
            parent = pve_topo.get(bridged_node)
            hint = "sys:" + bridged_node
            if cls == "unknown":
                cls = "server"       # a host behind a hypervisor's port that is no guest
        else:
            pm = sw if wired else (c.get("ap_mac") or "").lower()
            parent = f"unifi:{pm}" if f"unifi:{pm}" in topo_ids else gw_topo
            hint = None
        o = Obs(label, cls, "up", ["unifi"], mac=mac, ip=c.get("ip"),
                cat=CLASS_TO_CAT.get(cls, "infra"), parent_topo=parent, m=m, sys_hint=hint,
                pve_node=bridged_node)
        M.add(o)

    # 3) UniFi known clients (rest/user): named, seen within RETAIN_S, not online
    guest_names = {(n.get("label") or "").strip().lower() for n in nodes if n.get("kind") == "guest"}
    seen_lbl = {(g.label, g.ips[0] if g.ips else None) for g in M.items}
    seen_label_only = {g.label for g in M.items if g.macs}
    live_labels = {(g.label or "").lower() for g in M.items if g.macs and g.status == "up"}
    for u in sorted(known or [], key=lambda u: -(u.get("last_seen") or 0)):
        mac = (u.get("mac") or "").lower()
        if not mac or mac in M.by_mac:
            continue
        name, host = (u.get("name") or "").strip(), (u.get("hostname") or "").strip()
        if not (name or host):
            continue
        if "proxmox" in (u.get("oui") or "").lower() or mac in guest_mac:
            continue
        last = u.get("last_seen") or 0
        if now - last > RETAIN_S:
            continue
        uip = str(u.get("last_ip") or u.get("fixed_ip") or "") or None
        if uip and uip in M.by_ip:
            continue
        if (name or host).lower() in guest_names:
            continue
        wired = bool(u.get("is_wired"))
        if client_cat:
            try:
                cat, lbl = client_cat(name, host, u.get("oui"), wired, mac, uip)
            except Exception:
                cat, lbl = "unknown", None
        else:
            cat, lbl = "unknown", None
        label = lbl or name or host
        if lbl and lbl in seen_label_only:
            continue                     # curated multi-NIC machine already present
        if label.lower() not in _GENERIC_LABELS and label.lower() in live_labels:
            continue                     # same named device, another (old/random) MAC
        if (label, uip) in seen_lbl:
            continue
        seen_lbl.add((label, uip))
        cls = client_class(cat, label, mac, u.get("oui"))
        pm = (u.get("last_uplink_mac") or "").lower()
        parent = f"unifi:{pm}" if f"unifi:{pm}" in topo_ids else gw_topo
        m = {"wired": wired, "mac": mac, "offline_h": round((now - last) / 3600.0, 1)}
        if u.get("oui"):
            m["vendor"] = u["oui"]
        o = Obs(label, cls, "down", ["unifi_known"], mac=mac, ip=uip,
                cat=CLASS_TO_CAT.get(cls, "infra"), parent_topo=parent, m=m)
        o.m["last_seen_unifi"] = int(last)
        M.add(o)

    if excluded is None:
        excluded = []

    def gw_alias(ip, feed, name=None):
        """The gateway answers on one LAN address per VLAN (UniFi networkconf),
        none of which is its node ip, and an NMS or the ICMP sweep reports those
        addresses as separate devices (ARP shows a sibling MAC next to the device
        MAC). Fold them into the gateway body, visibly: src + m.lan_ips (+ m.snmp_name)."""
        g = by_topo.get(gw_topo)
        if g is None:
            return None
        if feed not in g.src:
            g.src.append(feed)
        lan = g.m.setdefault("lan_ips", [])
        if ip not in lan:
            lan.append(ip)
        if name:
            g.m.setdefault("snmp_name", name)
        return g

    # 4) LibreNMS devices: source tag on known ones, bodies for the rest
    for d in ((all_data.get("netmap") or {}).get("devices") or []):
        ip = str(d.get("ip") or "")
        if not _ip_ok(ip):
            excluded.append({"feed": "snmp", "key": ip or None, "name": d.get("name"),
                             "reason": "loopback or invalid address (LibreNMS polling itself)"})
            continue
        g = M.by_ip.get(ip)
        if g is None and ip in gw_lan and gw_topo in by_topo:
            # a gateway LAN address -- unless the NMS names a different box there
            # (e.g. a satellite or cable modem on the gateway's WAN-side subnet)
            nm = (d.get("name") or "").lower()
            if not nm or any(k in nm for k in _GW_NAMES):
                g = gw_alias(ip, "snmp", d.get("name"))
                continue
        if g is not None:
            if "snmp" not in g.src:
                g.src.append("snmp")
            continue
        up = bool(d.get("up"))
        cls = client_class(None, d.get("name"), group=d.get("group"))
        if cls == "unknown" and d.get("group") == "network":
            cls = "network_device"
        o = Obs(d.get("name") or ip, cls, "up" if up else "down", ["snmp"], ip=ip,
                cat=CLASS_TO_CAT.get(cls, "infra"), parent_topo=gw_topo, m={"ip": ip})
        M.add(o)

    # 5) probe: live hosts nothing else lists (the graph shows only 24)
    probe = all_data.get("probe") or {}
    prtt = probe.get("rtt") or {}
    for ip in probe.get("unknown") or []:
        ip = str(ip)
        if not _ip_ok(ip):
            excluded.append({"feed": "probe", "key": ip, "reason": "invalid address"})
            continue
        if ip in gw_lan and ip not in M.by_ip and gw_alias(ip, "probe") is not None:
            continue
        g = M.by_ip.get(ip)
        if g is not None:
            if "probe" not in g.src:
                g.src.append("probe")
            continue
        m = {"ip": ip}
        r = prtt.get(ip) or {}
        if r.get("rtt") is not None:
            m["rtt_ms"] = r["rtt"]
        if r.get("loss") is not None:
            m["loss"] = r["loss"]
        cls = "unknown"
        if client_cat:
            try:
                cls = client_class(client_cat(None, None, None, None, None, ip)[0])
            except Exception:
                pass
        M.add(Obs(ip, cls, "up", ["probe"], ip=ip, cat=CLASS_TO_CAT.get(cls, "infra"),
                  parent_topo=gw_topo, m=m))
    for g in M.items:
        if any(ip in prtt for ip in g.ips) and "probe" not in g.src:
            g.src.append("probe")

    # 6) Frigate cameras
    fr = all_data.get("frigate") or {}
    fps = {c.get("name"): c for c in (fr.get("cams") or []) if isinstance(c, dict)}
    nvr = next((g for g in M.items if (g.topo or "").startswith("ext:nvr")), None)
    for cam in all_data.get("cameras") or []:
        if not isinstance(cam, str):
            continue
        c = fps.get(cam)
        m = {}
        if c and c.get("fps") is not None:
            m["fps"] = c["fps"]
            if c.get("dfps") is not None:
                m["dfps"] = c["dfps"]
            st = "up" if c["fps"] > 0 else "down"
        elif fr.get("up") and fps:
            st = "down"
        else:
            st = "unknown"
        o = Obs(cam.replace("_", " "), "camera", st, ["frigate"], name="camera:" + cam,
                cat="monitor", m=m, sys_hint=cam_sys or (system_for(nvr) if nvr else None) or "sys:home",
                parent_topo=nvr.topo if nvr else gw_topo)
        M.add(o)

    # 7) Cloudflare edge
    cf = ((all_data.get("edge") or {}).get("cloudflare") or {})
    if isinstance(cf, dict) and cf:
        m = {}
        for k in ("req_per_min", "err_per_min", "ha_connections", "active_streams"):
            if cf.get(k) is not None:
                m[k] = cf[k]
        if cf.get("locations"):
            m["locations"] = cf["locations"]
        st = "up" if cf.get("up") else ("down" if cf.get("up") is False else "unknown")
        M.add(Obs("Cloudflare", "edge", st, ["cloudflare"], name="cloudflare", cat="network",
                  m=m, parent_topo="wan" if "wan" in topo_ids else None))

    # operator same-device groups first, so detection sees the merged device
    if same:
        M.items = apply_same(M.items, same)
        M.by_mac, M.by_vm, M.by_ip, M.by_name = {}, {}, {}, {}
        for g in M.items:
            M._index(g)
    # 8) switches: vendor/LLDP detection, chassis grouping, inferred unmanaged ones
    switch_pass(M, nodes, stas, known, devices, pve_by_port, guest_mac, now)
    # 9) operator-declared devices
    declared_pass(M, declared)
    return M.items


def _drop(M, h):
    """Remove an observation that was absorbed into another one."""
    M.items = [x for x in M.items if x is not h]
    for idx in (M.by_mac, M.by_vm, M.by_ip, M.by_name):
        for k in [k for k, v in idx.items() if v is h]:
            del idx[k]


def switch_pass(M, nodes, stas, known, devices, pve_by_port, guest_mac, now):
    """Find the switches UniFi does not manage.

    * Vendor/OUI + evidence -> class `switch` (see SWITCH_VENDORS). Evidence: an
      LLDP neighbour on a UniFi port, a switch-like name, sibling MACs of one
      chassis, other wired hosts behind the same UniFi port. A router/AP/phone
      name vetoes it; consumer vendors need a name or LLDP clue.
    * Chassis: MACs of one switch-vendor OUI within CHASSIS_SPAN of each other on
      the same /24 (from the live station list AND UniFi's known-client list) are
      one device; their bodies fold into the oldest (merge_ok).
    * Inferred: a UniFi port with >= INFER_MIN wired clients that are not Proxmox
      guests and have no detected switch among them gets a synthetic body
      `inferred:switch:<uplink mac>:<port>` and those clients become its children.
    """
    devices = devices or []
    dev_macs, dev_label = set(), {}
    for n in nodes:
        nid = str(n.get("id") or "")
        if nid.startswith("unifi:"):
            mac = nid.split(":", 1)[1]
            dev_macs.add(mac)
            dev_label[mac] = {"gateway": "UDM", "switch": "USW", "ap": "AP"}.get(n.get("kind"), n.get("label") or "UniFi")
    for d in devices:
        if d.get("mac"):
            dev_macs.add(str(d["mac"]).lower())

    # every MAC UniFi knows (live first, then rest/user within RETAIN_S): vendor, ip, wired
    pool = {}
    for c in stas or []:
        mac = (c.get("mac") or "").lower()
        if mac:
            pool[mac] = {"vendor": c.get("oui"), "ip": c.get("ip"), "wired": bool(c.get("is_wired")), "live": True}
    for u in known or []:
        mac = (u.get("mac") or "").lower()
        if not mac or mac in pool or now - (u.get("last_seen") or 0) > RETAIN_S:
            continue
        pool[mac] = {"vendor": u.get("oui"), "ip": u.get("last_ip") or u.get("fixed_ip"),
                     "wired": bool(u.get("is_wired")), "live": False}

    # wired stations per UniFi port (Proxmox host ports and guests excluded)
    ports = {}
    for c in stas or []:
        mac = (c.get("mac") or "").lower()
        sw = (c.get("sw_mac") or "").lower()
        if not mac or not c.get("is_wired") or not sw or c.get("sw_port") is None:
            continue
        key = (sw, c.get("sw_port"))
        if key in pve_by_port or mac in guest_mac or mac in dev_macs:
            continue
        if "proxmox" in (c.get("oui") or "").lower():
            continue
        ports.setdefault(key, []).append(mac)
    port_of = {mac: key for key, macs in ports.items() for mac in macs}

    # LLDP neighbours the UniFi devices see (not UniFi devices themselves)
    lldp = []
    for d in devices:
        dmac = str(d.get("mac") or "").lower()
        for nb in d.get("lldp_table") or []:
            ch = str(nb.get("chassis_id") or "").lower()
            if not ch or ch in dev_macs or _mac_int(ch) is None:
                continue
            lldp.append({"dev": dmac, "port": nb.get("local_port_idx"), "chassis": ch,
                         "ips": [str(i) for i in (nb.get("mgmt_ips") or []) if _ip_ok(i) and ":" not in str(i)],
                         "port_id": nb.get("port_id")})

    lan24 = set()
    for c in stas or []:
        if c.get("ip") and _ip_ok(c["ip"]):
            lan24.add(str(ipaddress.ip_network(f"{c['ip']}/24", strict=False)))

    def conflict(a, b):
        """Two addresses on two different LAN /24s = two devices. An interface
        address outside every LAN /24 (a transport/WAN-side IP on a router or
        switch port, e.g. a transit link's /30) is no evidence either way."""
        if not a or not b or _same_24(a, b):
            return False
        try:
            na = str(ipaddress.ip_network(f"{a}/24", strict=False))
            nb = str(ipaddress.ip_network(f"{b}/24", strict=False))
        except ValueError:
            return False
        return na in lan24 and nb in lan24

    def siblings(mac, ip):
        mi = _mac_int(mac)
        out = []
        for om, info in pool.items():
            if om == mac or om[:8] != mac[:8] or is_laa(om) or not info.get("wired"):
                continue
            oi = _mac_int(om)
            if mi is None or oi is None or abs(oi - mi) > CHASSIS_SPAN:
                continue
            if conflict(ip, info.get("ip")):
                continue
            out.append(om)
        return sorted(out)

    lldp_hit = {}                             # id(obs) -> lldp entry
    for e in lldp:
        ci = _mac_int(e["chassis"])
        hit = next((M.by_ip[i] for i in e["ips"] if i in M.by_ip), None)
        if hit is None:
            for g in M.items:
                if any(m[:8] == e["chassis"][:8] and _mac_int(m) is not None
                       and abs(_mac_int(m) - ci) <= CHASSIS_SPAN for m in g.macs):
                    hit = g
                    break
        if hit is None:                       # speaks LLDP, never seen as a station
            hit = Obs(f"Switch (LLDP) on {dev_label.get(e['dev'], 'UniFi')} port {e['port']}",
                      "switch", "up", ["lldp"], mac=e["chassis"], cat="network",
                      parent_topo=f"unifi:{e['dev']}", m={"wired": True}, sys_hint="sys:core")
            M.items.append(hit)
            M._index(hit)
        lldp_hit[id(hit)] = e

    switches = []
    for g in list(M.items):
        if g not in M.items or g.vm or not g.macs or (g.topo or "").startswith("unifi:"):
            continue
        mac = next((m for m in g.macs if not is_laa(m)), None)
        if mac is None or mac in dev_macs:
            continue
        info = pool.get(mac) or {}
        vendor = g.m.get("vendor") or info.get("vendor")
        tier = vendor_tier(vendor)
        e = lldp_hit.get(id(g))
        wired = g.m.get("wired") if g.m.get("wired") is not None else info.get("wired")
        if not (wired or e) or tier is None and not e:
            continue
        ip = g.ips[0] if g.ips else info.get("ip")
        sib = siblings(mac, ip) if tier in ("A", "B") else []
        port = port_of.get(mac)
        behind = [x for x in ports.get(port, []) if x != mac and x not in sib and x not in g.macs] if port else []
        ev, score = [], 0
        if tier:
            score += {"A": 2, "B": 1, "C": 0}[tier]
            ev.append(f"vendor:{vendor}")
        if e:
            score += 2
            ev.append(f"lldp:{dev_label.get(e['dev'], e['dev'])} port {e['port']}")
        named = _name_switchy(g.label) or _name_switchy(g.m.get("hostname"))
        if named:
            score += 2
            ev.append("name")
        if sib:
            score += 1
            ev.append(f"chassis:{len(sib) + 1} macs")
        if behind:
            score += 1
            ev.append(f"hosts-behind:{len(behind)}")
        veto = _name_not_switch(g.label) or _name_not_switch(g.m.get("hostname"))
        from_ok = g.cls in ("unknown", "network_device", "switch") or (
            g.cls in ("phone", "tablet", "computer") and tier in ("A", "B")
            and ((g.label or "").lower() in _GENERIC_LABELS or _looks_like_addr(g.label)))
        is_sw = score >= 2 and not veto and from_ok and (tier in ("A", "B") or e or named)
        if sib and from_ok and g.cls in ("unknown", "network_device", "switch"):
            # one chassis: pull every sibling MAC (and its observation) into this one
            for sm in sib:
                h = M.by_mac.get(sm)
                if h is not None and h is not g and not h.vm:
                    g.absorb(h)
                    _drop(M, h)
                if sm not in g.macs:
                    g.macs.append(sm)
            if e and e["chassis"] not in g.macs:
                g.macs.append(e["chassis"])
            g.merge_ok = True
            g.m["chassis_macs"] = sorted(set(g.macs))
            M._index(g)
        if not is_sw:
            continue
        if e and e["chassis"] not in g.macs:
            g.macs.append(e["chassis"])
            g.merge_ok = True
            g.m["chassis_macs"] = sorted(set(g.macs))
            M._index(g)
        if g.cls != "switch":
            g.reclass_ok = True
        g.cls, g.cat, g.hub = "switch", "network", True
        if (g.label or "").lower() in _GENERIC_LABELS or _looks_like_addr(g.label) or g.label == mac:
            g.label = f"{_vendor_short(vendor)} switch" if vendor else "Switch"
        g.m["switch_evidence"] = ev
        if vendor:
            g.m.setdefault("vendor", vendor)
        if e and "lldp" not in g.src:
            g.src.append("lldp")
        if port:
            g.m["uplink_port"] = port[1]
            g.m["uplink_mac"] = port[0]
            g.parent_topo = f"unifi:{port[0]}"     # the UniFi port it hangs off, from the station table
        switches.append((g, port, e))

    # parents: hosts sharing a UniFi port with a detected switch hang off that switch
    on_port = {}
    for g, port, e in switches:
        key = port or ((e["dev"], e["port"]) if e else None)
        if key:
            on_port.setdefault(key, []).append((0 if e else 1, g.macs[0], g))
    hubbed = set()
    for key, cands in on_port.items():
        cands.sort(key=lambda t: (t[0], t[1]))
        hub = cands[0][2]
        hubbed.add(key)
        if len(cands) > 1 and cands[1][0] == cands[0][0]:
            continue                      # two equal candidates on one port: order unknown, leave flat
        # the LLDP neighbour is the box physically on the UniFi port; anything else
        # UniFi learns on that port (other switches included) is behind it
        for mac in ports.get(key, []):
            h = M.by_mac.get(mac)
            if h is not None and h is not hub and (h.cls != "switch" or cands[0][0] == 0):
                h.parent_ref = "mac:" + hub.macs[0]
                if not h.m.get("behind"):
                    h.m["behind"] = "switch"

    # inferred unmanaged switches
    for key in sorted(ports, key=lambda k: (k[0], str(k[1]))):
        if key in hubbed:
            continue
        kids = [M.by_mac.get(mac) for mac in ports[key]]
        kids = [k for k in kids if k is not None and not k.vm]
        uniq = []
        for k in kids:
            if all(k is not u for u in uniq):
                uniq.append(k)
        if len(uniq) < INFER_MIN:
            continue
        sw, port = key
        sid = f"inferred:switch:{sw}:{port}"
        st = "up" if any(k.status == "up" for k in uniq) else "unknown"
        cand = sorted(k.label for k in uniq if k.cls in ("network_device", "switch", "ap"))
        m = {"inferred": True, "wired": True, "uplink_mac": sw, "uplink_port": port,
             "clients": len(uniq),
             "switch_evidence": [f"{len(uniq)} wired non-guest clients on {dev_label.get(sw, sw)} port {port}"]}
        if cand:
            m["hub_candidates"] = cand    # a router/AP on that port may itself be the switch
        o = Obs(f"Switch on {dev_label.get(sw, 'UniFi')} port {port}", "switch", st, ["inferred"],
                cat="network", parent_topo=f"unifi:{sw}", m=m, sys_hint="sys:core", decl=sid)
        o.hub = True
        M.items.append(o)
        for k in uniq:
            k.parent_ref = sid
            k.m.setdefault("behind", "inferred_switch")


def declared_pass(M, declared):
    for d in declared or []:
        did = d["id"].strip()
        mac = str(d.get("mac") or "").lower() or None
        ip = str(d.get("ip")) if d.get("ip") else None
        cls = d.get("class") if d.get("class") in SHELL_OF_CLASS else "unknown"
        g = M.by_mac.get(mac) if mac else None
        if g is None and ip and ip in M.by_ip:
            h = M.by_ip[ip]
            if not mac or not h.macs or mac in h.macs:
                g = h
        if g is None:
            g = Obs(d.get("label") or did, cls, "unknown", ["declared"], mac=mac, ip=ip,
                    cat=CLASS_TO_CAT.get(cls, "infra"), decl=did,
                    sys_hint="sys:core" if cls in ("switch", "ap", "gateway", "network_device") else None)
            M.items.append(g)
            M._index(g)
        else:
            if "declared" not in g.src:
                g.src.append("declared")
            if d.get("label"):
                g.label = d["label"]
            if cls != "unknown" and g.cls != cls:
                g.cls, g.cat, g.reclass_ok = cls, CLASS_TO_CAT.get(cls, "infra"), True
            g.decl = g.decl or did
        g.m["declared"] = True
        if d.get("parent"):
            g.parent_ref = str(d["parent"])
        if cls in HUB_CLASSES or cls in ("ap", "gateway") or d.get("hub"):
            g.hub = True
        for cm in d.get("children_macs") or []:
            h = M.by_mac.get(str(cm).lower())
            if h is not None and h is not g:
                h.parent_ref = did


# ---- short display names (CONTRACTS section 7) -------------------------------------
# `label` stays the full name (the detail card); `short` is what the screens print by
# default. Pure rules, no state: the same label always trims the same way. A clash
# inside one system is broken with a word from each body's own label, else with the
# shortest unique tail of its id, so the suffix belongs to the device, not to an order.
SHORT_MAX = 14
NAMES_PATH = os.environ.get("UNIVERSE_NAMES") or os.path.join(_UDIR, "universe_names.json")
_names_cache = {"mtime": None, "map": {}}
_NO_SHORT = {"localhost", "unknown", "none", "null", "(none)", "unnamed", "(unknown)"}
# well-known applications and devices: the noise-stripped, lower-cased label -> display name
_PRETTY = {
    "homeassistant": "Home Assistant", "home-assistant": "Home Assistant", "hass": "Home Assistant",
    "pihole": "Pi-hole", "pi-hole": "Pi-hole", "nginxproxymanager": "NPM", "nginx-proxy-manager": "NPM",
    "proxmox-backup-server": "PBS", "uptimekuma": "Uptime Kuma", "uptime-kuma": "Uptime Kuma",
    "speedtest-tracker": "Speedtest", "apache-guacamole": "Guacamole", "guacamole": "Guacamole",
    "stirling-pdf": "Stirling PDF", "technitiumdns": "Technitium", "technitium": "Technitium",
    "actualbudget": "Actual Budget", "isponsorblock": "iSponsorBlock", "crafty-controller": "Crafty",
    "homelab-dashboard": "Dashboard", "rokustreamingstick": "Roku Stick", "vaultwarden": "Vaultwarden",
    "grafana": "Grafana", "emby": "Emby", "plex": "Plex", "jellyfin": "Jellyfin", "frigate": "Frigate",
    "immich": "Immich", "ollama": "Ollama", "gitea": "Gitea", "tdarr": "Tdarr", "threadfin": "Threadfin",
    "librenms": "LibreNMS", "netbox": "NetBox", "searxng": "SearXNG", "checkmk": "Checkmk",
    "cockpit": "Cockpit", "homarr": "Homarr", "dashy": "Dashy", "traccar": "Traccar",
    "akvorado": "Akvorado", "litellm": "LiteLLM", "renovate": "Renovate", "umami": "Umami",
    "affine": "AFFiNE", "agentdvr": "AgentDVR", "iventoy": "iVentoy", "globaleaks": "GlobaLeaks",
    "gatus": "Gatus", "openldap": "OpenLDAP", "freeradius": "FreeRADIUS", "starlink": "Starlink",
    "zabbix": "Zabbix", "hermes": "Hermes", "docker": "Docker", "sftp": "SFTP", "mail": "Mail",
    "portainer": "Portainer", "nextcloud": "Nextcloud", "paperless": "Paperless", "sonarr": "Sonarr",
    "radarr": "Radarr", "prowlarr": "Prowlarr", "qbittorrent": "qBittorrent", "adguard": "AdGuard",
}
# network-gear vendors: a switch/router labelled "<vendor> <model ...>" shows as the vendor
_NET_VENDORS = {"juniper": "Juniper", "cisco": "Cisco", "nokia": "Nokia", "adva": "ADVA",
                "arista": "Arista", "aruba": "Aruba", "mikrotik": "MikroTik", "alcatel-lucent": "Alcatel",
                "alcatel": "Alcatel", "brocade": "Brocade", "extreme": "Extreme", "edgecore": "Edgecore",
                "mellanox": "Mellanox", "fortinet": "Fortinet", "fortigate": "FortiGate"}
_NET_CLASSES = ("switch", "network_device", "gateway", "ap")
# consumer vendors, dropped first when a device name is too long ("Google Home Mini" -> "Home Mini")
_VENDOR_WORDS = {"google", "amazon", "apple", "samsung", "elgato", "govee", "aqara", "philips",
                 "signify", "roku", "sonos", "midea", "tp-link", "tplink", "netgear", "lg", "sony",
                 "vizio", "ecobee", "wyze", "eufy", "reolink", "brother", "epson", "canon", "lenovo",
                 "dell", "asus", "acer", "creality", "bambu", "anker", "shelly", "tuya", "kasa",
                 "xiaomi", "huawei", "ubiquiti", "unifi", "hp", "microsoft", "intel", "nvidia"}
_ABBREV = {"network": "net", "networks": "net", "server": "srv", "controller": "ctl",
           "orchestrator": "orch", "monitor": "mon", "monitoring": "mon", "scheduler": "sched",
           "dashboard": "dash", "homeassistant": "ha", "pterodactyl": "ptero", "servicenow": "snow",
           "management": "mgmt", "manager": "mgr", "backup": "bkp", "python": "py",
           "development": "dev", "production": "prod", "template": "tmpl", "streaming": "stream"}
_NOISE_WORDS = {"local", "lxc", "ct", "vm", "container"}
_STOP_WORDS = {"on", "port", "the", "of", "via", "and", "for", "at", "in", "to"}
_SHORT_RULES = [
    # "udm-pro-se-Branch" -> "UDM Branch"
    (re.compile(r"^udm(?:[-_ ]pro)?(?:[-_ ](?:se|max))?[-_ ]([a-z]\w*)$", re.I), lambda m: "UDM " + m.group(1)),
    # "USW Pro Max 24" -> "USW 24"
    (re.compile(r"^usw(?:[-_ ]+(?:pro|lite|max|enterprise|flex|ultra|aggregation|industrial|xg|hd))*"
                r"[-_ ]+(\d+)(?:[-_ ]*poe)?$", re.I), lambda m: "USW " + m.group(1)),
    # "TP-Link Deco Node 3" -> "Deco 3"
    (re.compile(r"^tp[-_ ]?link[-_ ]+deco(?:[-_ ]+node)?[-_ ]*(\w*)$", re.I),
     lambda m: ("Deco " + m.group(1)).strip()),
    # "Switch on UDM port 7" / "Switch (LLDP) on USW port 5" -> "UDM p7 switch"
    (re.compile(r"^switch(?: \(lldp\))? on (\S+) port (\S+)$", re.I), lambda m: f"{m.group(1)} p{m.group(2)} switch"),
    # "idrac-22T4R52" -> "iDRAC" (the service tag is noise on a screen)
    (re.compile(r"^idrac(?:[-_ ].*)?$", re.I), lambda m: "iDRAC"),
]
_SERIAL_TAIL = re.compile(r"[-_ ](?=[0-9A-Fa-f]*\d)(?=[0-9A-Fa-f]*[A-Fa-f])[0-9A-Fa-f]{4,6}$")
_MODEL_TOKEN = re.compile(r"^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9.]{2,7}$")


def load_names(path=None):
    """{id -> short} operator overrides, re-read only when the file changes. A missing
    or broken file means no overrides, never an error. A null or "" value hides the
    short name for that id (the screens then show nothing until the body is clicked)."""
    path = path or NAMES_PATH
    try:
        mt = os.path.getmtime(path)
    except OSError:
        _names_cache.update(mtime=None, map={})
        return {}
    if mt != _names_cache["mtime"]:
        m = {}
        try:
            with open(path) as f:
                d = json.load(f)
            if not isinstance(d, dict):
                raise ValueError("not an object")
            for k, v in d.items():
                if isinstance(k, str) and (v is None or isinstance(v, str)):
                    m[k] = v.strip() if isinstance(v, str) else None
        except Exception as e:
            print(f"[universe] {path} unreadable, ignoring: {type(e).__name__}: {e}", flush=True)
            m = {}
        _names_cache.update(mtime=mt, map=m)
    return _names_cache["map"]


def _clip(s):
    s = " ".join(str(s).split())
    if len(s) <= SHORT_MAX:
        return s
    cut = s[:SHORT_MAX - 1]
    if " " in cut[4:]:
        cut = cut[:cut.rindex(" ")]
    return cut.rstrip(" -_.") + "…"


def _strip_noise(s):
    for _ in range(3):
        before = s
        s = re.sub(r"\s*\([^)]*\)\s*$", "", s).strip() or s           # "Camera NVR (remote)"
        s = re.sub(r"[-_ ]v?\d+(?:\.\d+){1,3}$", "", s) or s          # "-1.2.3", " v2.0"
        s = re.sub(r"[-_]v\d+$", "", s, flags=re.I) or s               # "-v2"
        if " " not in s and "." in s and not _looks_like_addr(s):
            s = s.split(".")[0] or s                                   # FQDN -> host
        s = re.sub(r"[-_](?:ct|lxc|vm)\d*$", "", s, flags=re.I) or s   # "arr-stack-ct128"
        if re.search(r"[A-Z]", s):                                     # device names: serial tail
            s = _SERIAL_TAIL.sub("", s) or s                           # "SmartPlug-8CE9" -> "SmartPlug"
        if s == before:
            break
    return s


def _shorten(s):
    """Make an over-long name fit: abbreviate, drop noise/model/vendor words, then
    trailing words; hostnames keep their separators, device names use spaces."""
    device = bool(re.search(r"[A-Z]", s)) or " " in s
    toks = [t for t in re.split(r"[-_ ]+" if device else r"[-_]+", s) if t]
    seps = [] if device else re.findall(r"[-_]+", s)
    sep = " " if device else (seps[0] if seps else "-")

    def text(ts):
        return sep.join(ts)

    for drop in (lambda i, t: i > 0 and t.lower() in _NOISE_WORDS,
                 lambda i, t: i > 0 and bool(_MODEL_TOKEN.match(t)),
                 lambda i, t: device and t.lower() in _VENDOR_WORDS):   # a hostname keeps its product word
        if len(text(toks)) <= SHORT_MAX:
            break
        kept = [t for i, t in enumerate(toks) if not drop(i, t)]
        if kept:
            toks = kept
    if len(text(toks)) > SHORT_MAX:     # abbreviate lower-case words only ("Server Room" stays)
        toks = [(_ABBREV.get(t, t) if t.islower() and len(t) > 5 else t) for t in toks]
    while len(text(toks)) > SHORT_MAX and len(toks) > 1:
        toks = toks[:-1]
    return _clip(text(toks))


def short_name(label, cls=None):
    """Deterministic short display name, or None when the label is only an address
    (or means nothing on its own, like "localhost")."""
    s = " ".join(str(label or "").split())
    if not s or _looks_like_addr(s) or s.lower() in _NO_SHORT:
        return None
    s = _drop_prefix(s)
    for rx, fn in _SHORT_RULES:
        m = rx.match(s)
        if m:
            return _clip(fn(m))
    if cls in _NET_CLASSES:
        first = re.split(r"[\s(]+", s, maxsplit=1)[0].lower()
        if first in _NET_VENDORS:
            return _NET_VENDORS[first]
    if s.lower() in _PRETTY:
        return _PRETTY[s.lower()]
    s = _strip_noise(s)
    if _looks_like_addr(s) or s.lower() in _NO_SHORT:
        return None
    if s.lower() in _PRETTY:
        return _PRETTY[s.lower()]
    if len(s) <= SHORT_MAX:
        return s
    return _shorten(s)


def _name_prefixes():
    """Site words that prefix device names and mean nothing on screen ("Acme UDM"):
    UNIVERSE_NAME_PREFIXES, plus the brand and the first label of the domain."""
    out = [str(p).strip() for p in (config.UNIVERSE_NAME_PREFIXES or []) if str(p).strip()]
    for v in (config.BRAND, (config.DOMAIN or "").split(".")[0]):
        v = str(v or "").strip()
        if v and v.upper() != "GALAXY" and v not in out:
            out.append(v)
    return out


def _drop_prefix(s):
    for p in _name_prefixes():
        m = re.match(rf"^{re.escape(p)}[\s_-]+(\S.*)$", s, re.I)
        if m:
            return m.group(1)
    return s


_short_memo = {}


def _short_cached(label, cls):
    k = (label, cls)
    if k not in _short_memo:
        if len(_short_memo) > 4096:
            _short_memo.clear()
        _short_memo[k] = short_name(label, cls)
    return _short_memo[k]


def _fit(base, suffix):
    s = f"{base} {suffix}"
    if len(s) > SHORT_MAX:
        s = f"{base[:max(1, SHORT_MAX - len(suffix) - 1)].rstrip(' -_.')} {suffix}"
    return s


def _disambiguate(members):
    """Same short inside one system: a distinguishing word from each body's own label
    when every label offers one, else the shortest unique tail of each body id."""
    base = members[0]["short"]
    have = set(base.lower().split())
    words = []
    for b in members:
        ws = [w.strip("-.") for w in re.split(r"[\s()_/,]+", str(b.get("label") or ""))
              if w and w.lower() not in have and w.lower() not in _STOP_WORDS and not _looks_like_addr(w)]
        words.append(ws[0] if ws else None)
    if all(words) and len({w.lower() for w in words}) == len(words):
        outs = [_fit(base, w) for w in words]
        if len({o.lower() for o in outs}) == len(outs):
            for b, o in zip(members, outs, strict=False):
                b["short"] = o
            return
    keys = [re.sub(r"[^0-9a-z]", "", b["id"].lower()) for b in members]
    k = 2
    while k < max(len(x) for x in keys) and len({x[-k:] for x in keys}) < len(keys):
        k += 1
    for b, x in zip(members, keys, strict=False):
        b["short"] = _fit(base, x[-k:])


def apply_shorts(bodies, systems, overrides=None):
    """Set `short` on every body and system that has one (mutates). Overrides win and
    are never renamed by a clash; every other clash inside a system is broken."""
    overrides = overrides or {}
    groups = {}
    for b in bodies:
        if b["id"] in overrides:
            v = overrides[b["id"]]
            if v:
                b["short"] = v
            else:
                b.pop("short", None)
            continue
        s = _short_cached(b.get("label"), b.get("class"))
        if s:
            b["short"] = s
            groups.setdefault((b.get("system"), s.lower()), []).append(b)
        else:
            b.pop("short", None)
    for key in sorted(groups, key=lambda k: (str(k[0]), k[1])):
        members = groups[key]
        if len(members) > 1:
            _disambiguate(sorted(members, key=lambda b: b["id"]))
    for s in systems:
        if s["id"] in overrides:
            if overrides[s["id"]]:
                s["short"] = overrides[s["id"]]
            continue
        s["short"] = _clip(str(_SYS_SHORT.get(s["id"]) or s.get("label") or s["id"].split(":", 1)[-1]).upper())


_SYS_SHORT = {}          # sys id -> short caption, refreshed from system_defs() each build


def system_for(o):
    if o.cls == "edge":
        return None
    if o.sys_hint:
        return o.sys_hint
    for ip in o.ips:
        for sid, _label, net, _accent in _site_defs():
            if net is not None and _in(ip, net):
                return sid
    if o.cls in ("gateway", "switch", "ap", "network_device"):
        return "sys:core"
    return "sys:home"


# ---- persistence --------------------------------------------------------------
class Store:
    def __init__(self, path=STORE_PATH):
        self.path = path
        self.lock = threading.RLock()
        self.data = None
        self.dirty = False
        self.saved_at = 0.0

    def _empty(self, now):
        return {"v": V, "created": now, "systems": {}, "bodies": {}, "alias": {}, "held": {}}

    def load(self, now=None):
        now = now or time.time()
        with self.lock:
            if self.data is not None:
                return self.data
            try:
                with open(self.path) as f:
                    d = json.load(f)
                if not isinstance(d, dict) or "bodies" not in d:
                    raise ValueError("not a universe store")
                for k, v in self._empty(now).items():
                    d.setdefault(k, v)
                self.data = d
            except FileNotFoundError:
                self.data = self._empty(now)
                self.dirty = True
            except Exception as e:     # corrupt: keep it aside for forensics, start over
                bad = f"{self.path}.corrupt.{int(now)}"
                try:
                    os.replace(self.path, bad)
                except OSError:
                    pass
                print(f"[universe] store unreadable ({type(e).__name__}); moved to {bad}", flush=True)
                self.data = self._empty(now)
                self.dirty = True
            return self.data

    def save(self, now=None, force=False):
        """Atomic: write temp in the same dir, fsync, rename over. A crash at any
        point leaves either the old file or the new one, never a partial one."""
        now = now or time.time()
        with self.lock:
            if self.data is None or not (force or self.dirty):
                return False
            d = os.path.dirname(os.path.abspath(self.path))
            os.makedirs(d, exist_ok=True)
            with open(self.path + ".lock", "a") as lk:
                fcntl.flock(lk, fcntl.LOCK_EX)
                try:
                    fd, tmp = tempfile.mkstemp(prefix=".universe.", suffix=".tmp", dir=d)
                    try:
                        with os.fdopen(fd, "w") as f:
                            json.dump(self.data, f, separators=(",", ":"), sort_keys=True)
                            f.flush()
                            os.fsync(f.fileno())
                        os.replace(tmp, self.path)
                    except BaseException:
                        try:
                            os.unlink(tmp)
                        except OSError:
                            pass
                        raise
                    try:
                        dfd = os.open(d, os.O_DIRECTORY)
                        os.fsync(dfd)
                        os.close(dfd)
                    except OSError:
                        pass
                finally:
                    fcntl.flock(lk, fcntl.LOCK_UN)
            self.dirty = False
            self.saved_at = now
            return True


def _alloc_slot(store, system, shell, now):
    used = set()
    for b in store["bodies"].values():
        if b.get("system") == system and b.get("shell") == shell:
            used.add(b.get("slot"))
    held = store["held"].get(f"{system}|{shell}") or {}
    n = 0
    while n in used or held.get(str(n), 0) > now:
        n += 1
    return n


def _ensure_system(store, sid, now):
    if sid is None or sid in store["systems"]:
        return
    # reserve the configured order for the known systems, append anything else
    order = system_order()
    taken = {v["slot"] for v in store["systems"].values()}
    if sid in order:
        slot = order.index(sid)
        if slot in taken:
            slot = max(taken | {len(order) - 1}) + 1
    else:
        slot = max(taken | {len(order) - 1}) + 1
    store["systems"][sid] = {"slot": slot, "first_seen": int(now)}


def _retire(store, bid, canonical):
    """A stored body proved to be another body: its id becomes an alias of the
    canonical one and its slot is freed at once (same as merge_same_in_store)."""
    bodies, alias = store["bodies"], store["alias"]
    bodies.pop(bid, None)
    for k in [k for k, v in alias.items() if v == bid]:
        alias[k] = canonical
    alias[bid] = canonical


def retire_orphans(store):
    """Bodies whose own id is an alias of ANOTHER live body can never be reported
    again (resolve maps their key elsewhere); e.g. a guest's MAC body minted before
    its vm: id was known. Retire them instead of showing them down for 30 days."""
    bodies, alias = store["bodies"], store["alias"]
    gone = [bid for bid in list(bodies)
            if alias.get(bid) not in (None, bid) and alias.get(bid) in bodies]
    for bid in gone:
        _retire(store, bid, alias[bid])
    return gone


def _claim_ips(o):
    out = list(o.ips)
    for ip in [o.m.get("ip")] + list(o.m.get("lan_ips") or []):
        if ip and _ip_ok(ip) and str(ip) not in out:
            out.append(str(ip))
    return out


def _ip_claims(store, now):
    """ip -> {body id} for addresses a strong body (or the gateway / the WAN edge)
    showed recently. An IP-only observation of such an address is that body."""
    claims = {}
    for bid, r in store["bodies"].items():
        cls = r.get("class")
        if not r.get("strong") and cls not in ("edge", "gateway"):
            continue
        win = RETAIN_S if cls in ("gateway", "edge") else IP_CLAIM_S
        ips = r.get("ips") or ({r["ip"]: r.get("last_seen", 0)} if r.get("ip") else {})
        for ip, t in ips.items():
            if now - (t or 0) <= win:
                claims.setdefault(ip, set()).add(bid)
    return claims


def _label_index(store, now):
    idx = {}
    for bid, r in store["bodies"].items():
        lb = (r.get("label") or "").strip().lower()
        if (not lb or lb in _GENERIC_LABELS or _looks_like_addr(lb) or len(lb) < 3
                or not r.get("strong") or now - r.get("last_seen", 0) > RETAIN_S):
            continue
        if bid.startswith("mac:") and is_laa(bid[4:]):
            continue
        idx.setdefault(lb, set()).add(bid)
    return idx


def resolve(store, obs, now, degraded=None, excluded=None):
    """Give each observation its permanent id, system, shell and slot. Mutates store.
    Returns list of (id, obs, record) and whether anything structural changed.

    Strong observations (MAC / vm / declared) resolve first; IP-only ones after,
    so they can fold into a strong body that owns their address:
      * an ip: alias (existing IP-only body)            -> that body (unchanged rule)
      * the IP is one a strong body showed within IP_CLAIM_S (or the gateway / WAN
        edge ever showed)                                 -> that body
      * the label names exactly one strong body (a VIP like "Zabbix")  -> that body
      * otherwise mint ip:<addr> -- except in a degraded build, where nothing is
        minted from an IP-only observation (it is listed in `excluded`).
    A strong observation whose MACs are all locally administered (randomised)
    and whose label names exactly one stored device folds into that device.
    An observation flagged merge_ok (one switch chassis) whose keys point at
    several stored bodies folds them into the oldest one."""
    alias, bodies = store["alias"], store["bodies"]
    changed = False
    out, used = [], {}
    strong_first = [o for o in obs if o.strong()] + [o for o in obs if not o.strong()]
    claims = labels = None
    for o in strong_first:
        keys = o.keys()
        bid = None
        hits = []
        for k in keys:
            if k.startswith("ip:"):
                continue
            t = alias.get(k)
            if t in bodies and t not in hits:
                hits.append(t)
        if hits:
            bid = hits[0]
            if len(hits) > 1 and o.merge_ok:
                bid = min(hits, key=lambda h: (bodies[h].get("first_seen", now), h))
                for h in hits:
                    if h != bid and h not in used:
                        _retire(store, h, bid)
                        changed = True
        if bid is None:
            for k in keys:
                if k.startswith("ip:") and k in alias and alias[k] in bodies:
                    cand = bodies[alias[k]]
                    # an IP alias only ever points at a body with no strong identity;
                    # never fold a different MAC/vm into it
                    if not cand.get("strong") or not o.strong():
                        bid = alias[k]
                        break
        if bid is None and not o.strong():
            if claims is None:
                claims, labels = _ip_claims(store, now), _label_index(store, now)
            for ip in o.ips:
                c = claims.get(ip) or set()
                if len(c) == 1:
                    bid = next(iter(c))
                    break
            if bid is None:
                lb = (o.label or "").strip().lower()
                c = labels.get(lb) or set()
                if len(c) == 1:
                    bid = next(iter(c))
            if bid is not None:
                o.folded = True
        if bid is None and o.macs and not o.vm and not o.decl and all(is_laa(m) for m in o.macs):
            if labels is None:
                claims, labels = _ip_claims(store, now), _label_index(store, now)
            c = labels.get((o.label or "").strip().lower()) or set()
            if len(c) == 1:
                bid = next(iter(c))
                o.folded = True
        if bid is None:
            if degraded and not o.strong():
                if excluded is not None:
                    excluded.append({"feed": "/".join(o.src) or "unknown",
                                     "key": o.ips[0] if o.ips else o.label,
                                     "reason": f"degraded build ({degraded}): not minting a body from an IP-only observation"})
                continue
            bid = keys[0] if keys else "name:" + (o.label or "unnamed").lower()
        if o.folded and bid in bodies:
            # an address/label/random-MAC sighting of a known device: it never
            # renames or reclassifies that device
            r = bodies[bid]
            o.label = r.get("label") or o.label
            if r.get("class"):
                o.cls, o.cat = r["class"], r.get("cat") or o.cat
            o.topo = o.topo or r.get("topo")
            o.parent_topo = o.parent_topo or r.get("parent_topo")
            if o.ips and bid != "ip:" + o.ips[0]:
                o.m.setdefault("seen_as_ip", o.ips[0])
        if bid in used:                       # two observations, one body: fold into the first
            used[bid].absorb(o)
            continue
        used[bid] = o
        rec = bodies.get(bid)
        if rec is None:
            system = system_for(o)
            _ensure_system(store, system, now)
            shell = shell_of(o.cls)
            rec = {"system": system, "shell": shell,
                   "slot": _alloc_slot(store, system, shell, now),
                   "first_seen": int(now), "class": o.cls}
            if now - store.get("created", now) <= BASELINE_S:
                rec["baseline"] = True
            bodies[bid] = rec
            changed = True
        elif (rec.get("class") == "unknown" and o.cls != "unknown") or (
                o.reclass_ok and o.cls in HUB_CLASSES and rec.get("class") not in HUB_CLASSES):
            # first real classification (or a detected switch that was misread,
            # e.g. a bench switch UniFi fingerprinted as "iPhone"): move once to the right
            # ring; the old slot is held for RETAIN_S so nobody else lands there.
            # A hub-class promotion also takes the hub's system (sys:core).
            system = system_for(o) if o.cls in HUB_CLASSES else rec["system"]
            shell = shell_of(o.cls)
            if (system, shell) != (rec["system"], rec["shell"]):
                _ensure_system(store, system, now)
                hk = f"{rec['system']}|{rec['shell']}"
                store["held"].setdefault(hk, {})[str(rec["slot"])] = now + RETAIN_S
                rec["reclassed"] = {"from": rec.get("class"), "at": int(now),
                                    "was": [rec["system"], rec["shell"], rec["slot"]]}
                rec["system"], rec["shell"] = system, shell
                rec["slot"] = _alloc_slot(store, system, shell, now)
            changed = True
        for k in keys:
            if k.startswith("ip:") and (o.strong() or o.folded):
                continue
            if alias.get(k) != bid:
                alias[k] = bid
                changed = True
        snap = {"class": o.cls, "cat": o.cat, "label": o.label, "topo": o.topo,
                "parent_topo": o.parent_topo, "strong": o.strong() or bool(rec.get("strong")),
                "parent_ref": o.parent_ref, "hub": True if o.hub else None,
                "lab": True if o.lab else None}
        if o.folded:
            snap = {}
        for k, v in snap.items():
            if rec.get(k) != v:
                if v is None:
                    rec.pop(k, None)
                else:
                    rec[k] = v
                changed = True
        if o.ips and rec.get("ip") != o.ips[0] and not o.folded:
            rec["ip"] = o.ips[0]
            changed = True
        ips = rec.setdefault("ips", {})
        for ip in _claim_ips(o):
            if ip not in ips:
                changed = True
            ips[ip] = int(now)
        if len(ips) > 8:
            for ip in sorted(ips, key=lambda i: ips[i])[:len(ips) - 8]:
                del ips[ip]
        rec["last_seen"] = int(now)
        out.append((bid, o, rec))
    return out, changed


# Kubernetes pods are replaced, not repaired: a rollout's surge replica or a deleted
# workload is held this long (not 30 days). Nodes keep the normal hold.
K8S_POD_RETAIN_S = float(os.environ.get("K8S_RETAIN_S", 6 * 3600))


def _retain_s(bid):
    return K8S_POD_RETAIN_S if bid.startswith("k8s:") and ":pod:" in bid else RETAIN_S


def expire(store, now, seen_ids, hold_systems=()):
    """Drop bodies unseen for their hold (RETAIN_S; Kubernetes pods K8S_POD_RETAIN_S),
    so their slots become free. Bodies in hold_systems (a feed that is not answering)
    are kept. Clean holds."""
    gone = [bid for bid, r in store["bodies"].items()
            if bid not in seen_ids and r.get("system") not in hold_systems
            and now - r.get("last_seen", r.get("first_seen", now)) > _retain_s(bid)]
    for bid in gone:
        del store["bodies"][bid]
    if gone:
        g = set(gone)
        for k in [k for k, v in store["alias"].items() if v in g]:
            del store["alias"][k]
    for hk in list(store["held"]):
        h = {s: t for s, t in store["held"][hk].items() if t > now}
        if h:
            store["held"][hk] = h
        else:
            del store["held"][hk]
    return gone


# ---- build --------------------------------------------------------------------
def _lab_override(bid):
    """UNIVERSE_LAB_VMIDS applies to Proxmox guest ids (vm:<node>:<vmid>) only."""
    if not bid.startswith("vm:"):
        return False
    node, _, vmid = bid[3:].partition(":")
    return config.is_lab_guest(node, vmid, None)


def lab_host_match(label, ips):
    """UNIVERSE_LAB_HOSTS: bench gear named by host name or address."""
    want = {str(h).strip().lower() for h in (config.UNIVERSE_LAB_HOSTS or []) if str(h).strip()}
    if not want:
        return False
    if str(label or "").strip().lower() in want:
        return True
    return any(str(ip) in want for ip in ips or ())


def build(obs, store_obj, now=None, fresh=True, topo=None, excluded=None, degraded=None,
          traffic=None, lab_ips=None, names=None, unknown_systems=()):
    """traffic: {"state": TrafficState, "tunnels": [...]} adds the `traffic` object;
    lab_ips: addresses of hosts in the Zabbix lab group (bodies get `lab: true`);
    names: {id -> short} overrides (default: NAMES_PATH);
    unknown_systems: system ids whose own feed is not answering (a Kubernetes API):
    their unreported bodies are "unknown", never "gone", and are not expired."""
    unknown_systems = set(unknown_systems or ())
    now = now or time.time()
    if excluded is None:
        excluded = []
    with store_obj.lock:
        store = store_obj.load(now)
        merged = merge_same_in_store(store, load_same())
        merged = bool(retire_orphans(store)) or merged
        # expire BEFORE allocating, so a slot freed today can be reused today; a
        # body reported in this very build is never expired (alias pre-pass)
        alias = store["alias"]
        returning = {alias[k] for o in obs for k in o.keys() if k in alias}  # noqa: SIM118
        gone = expire(store, now, returning, unknown_systems)
        resolved, changed = resolve(store, obs, now, degraded=degraded, excluded=excluded)
        seen = {bid for bid, _, _ in resolved}
        if changed or gone or merged:
            store_obj.dirty = True
        elif now - store_obj.saved_at >= PERSIST_EVERY_S:
            store_obj.dirty = True             # flush last_seen on a slow beat
        try:
            store_obj.save(now)
        except Exception as e:
            print(f"[universe] store save failed: {type(e).__name__}: {e}", flush=True)
        bodies_store = dict(store["bodies"])
        systems_store = dict(store["systems"])
        alias_store = dict(store["alias"])

    topo_nodes = (topo or {}).get("nodes") or []
    topo_ids = {n.get("id") for n in topo_nodes}
    topo_to_body = {}
    for bid, o, _rec in resolved:
        if o.topo:
            topo_to_body.setdefault(o.topo, bid)

    def parent_of(ptopo):
        if not ptopo:
            return None
        if ptopo in topo_to_body:
            return topo_to_body[ptopo]
        if ptopo in topo_ids:
            return ptopo
        return None

    lab_ips = set(lab_ips or ())
    bodies, by_class, up = [], {}, 0
    for bid, o, rec in resolved:
        new = (not rec.get("baseline")) and (now - rec["first_seen"] < NEW_S)
        b = {"id": bid, "label": o.label or bid, "class": o.cls, "cat": o.cat or CLASS_TO_CAT.get(o.cls, "infra"),
             "system": rec["system"], "parent": parent_of(o.parent_topo),
             "shell": rec["shell"], "slot": rec["slot"], "seed": hash32(bid),
             "status": o.status, "first_seen": rec["first_seen"], "last_seen": rec["last_seen"],
             "new": bool(new), "m": dict(o.m), "src": list(o.src)}
        if o.ips and "ip" not in b["m"]:
            b["m"]["ip"] = o.ips[0]
        if o.topo:
            b["topo"] = o.topo
        if o.hub or o.cls in HUB_CLASSES:
            b["hub"] = True
        if o.parent_ref:
            b["_ref"] = o.parent_ref
        if b["parent"] == bid:
            b["parent"] = None
        if (o.lab or (lab_ips and lab_ips.intersection(_claim_ips(o))) or _lab_override(bid)
                or lab_host_match(o.label, _claim_ips(o))):
            b["lab"] = True
        if o.status == "down":
            # why it is down (additive): a Proxmox guest that is powered off is "stopped",
            # not an outage; anything else a feed reported as down is "offline"
            b["down_why"] = o.down_why or (
                "stopped" if (o.vm and "proxmox" in o.src and o.cls in ("guest_lxc", "guest_vm")) else "offline")
        bodies.append(b)
    # persisted but not reported this build: present as down (or unknown when stale)
    for bid, rec in bodies_store.items():
        if bid in seen:
            continue
        cls = rec.get("class") or "unknown"
        held = rec.get("system") in unknown_systems
        b = {"id": bid, "label": rec.get("label") or bid, "class": cls,
             "cat": rec.get("cat") or CLASS_TO_CAT.get(cls, "infra"),
             "system": rec.get("system"), "parent": parent_of(rec.get("parent_topo")),
             "shell": rec["shell"], "slot": rec["slot"], "seed": hash32(bid),
             "status": "down" if fresh and not held else "unknown",
             "first_seen": rec.get("first_seen"), "last_seen": rec.get("last_seen"),
             "new": False, "m": {}, "src": []}
        if rec.get("topo") and rec["topo"] in topo_ids:
            b["topo"] = rec["topo"]
        if rec.get("hub") or cls in HUB_CLASSES:
            b["hub"] = True
        if rec.get("parent_ref"):
            b["_ref"] = rec["parent_ref"]
        # a lab guest that was torn down keeps its badge while it shows as down
        if (rec.get("lab") or (lab_ips and lab_ips.intersection(rec.get("ips") or ())) or _lab_override(bid)
                or lab_host_match(rec.get("label"), rec.get("ips") or ())):
            b["lab"] = True
        if fresh and not held:
            # no feed reported it this build: it left (removed guest, departed client) and
            # is held in its slot for RETAIN_S. Shown as down, but it is not an outage.
            b["down_why"] = "gone"
            if rec.get("last_seen"):
                b["gone_s"] = max(0, int(now - rec["last_seen"]))
        bodies.append(b)
    for b in bodies:
        by_class[b["class"]] = by_class.get(b["class"], 0) + 1
        if b["status"] == "up":
            up += 1

    # explicit parents (a detected / inferred / declared hub): a body id, an alias
    # key of one (e.g. "mac:.."), or a topology id
    ids = {b["id"] for b in bodies}
    reparented = {}
    for b in bodies:
        ref = b.pop("_ref", None)
        if not ref:
            continue
        p = ref if ref in ids else alias_store.get(ref)
        if p not in ids:
            p = topo_to_body.get(ref) or (ref if ref in topo_ids else None)
        if p and p != b["id"]:
            b["parent"] = p
            reparented[b["id"]] = p

    # parent links must resolve; anything left dangling is cleared
    for b in bodies:
        p = b["parent"]
        if p is not None and p not in topo_ids and p not in ids:
            b["parent"] = None

    caps = {}
    for b in bodies:
        k = b["system"] or ""
        s = caps.setdefault(k, {})
        sk = str(b["shell"])
        s[sk] = max(s.get(sk, 0), b["slot"] + 1)

    anchors = _anchors(bodies, topo_nodes)
    defs = system_defs()
    _SYS_SHORT.clear()
    _SYS_SHORT.update({k: v.get("short") for k, v in defs.items() if v.get("short")})
    systems = []
    for sid, rec in sorted(systems_store.items(), key=lambda kv: kv[1]["slot"]):
        d = defs.get(sid) or _extra_system_def(sid) or {"label": sid.split(":", 1)[1], "kind": "pvehost",
                                                        "accent": system_accent(sid)}
        s = {"id": sid, "label": d["label"], "kind": d["kind"], "accent": d["accent"],
             "seed": hash32(sid), "slot": rec["slot"], "shells": caps.get(sid, {}),
             "count": sum(1 for b in bodies if b["system"] == sid)}
        if anchors.get(sid):
            s["anchor"] = anchors[sid]
            s["topo"] = anchors[sid]
        systems.append(s)

    links = []
    for lk in (topo or {}).get("links") or []:
        a, bb = topo_to_body.get(lk.get("source")), topo_to_body.get(lk.get("target"))
        if a and bb and reparented.get(bb, a) != a:
            continue                       # replaced by the hub -> child link below
        if a and bb:
            e = {"a": a, "b": bb, "kind": "uplink"}
            if lk.get("measured"):
                e["bps"] = lk.get("bps")
            if lk.get("capacity_bps"):
                e["capacity_bps"] = lk["capacity_bps"]
            links.append(e)
    linked = {(e["a"], e["b"]) for e in links}
    for b in bodies:
        p = b["parent"]
        if p and p in ids and (p, b["id"]) not in linked and ("topo" not in b or b["id"] in reparented):
            links.append({"a": p, "b": b["id"], "kind": "uplink"})
    for f in (topo or {}).get("flows") or []:
        a, bb = topo_to_body.get(f.get("src")), topo_to_body.get(f.get("dst"))
        if a and bb and f.get("measured"):
            links.append({"a": a, "b": bb, "bps": f.get("bps"),
                          "kind": "nfs" if (f.get("proto") or "").upper() == "NFS" else "flow",
                          "proto": f.get("proto")})

    try:
        apply_shorts(bodies, systems, load_names() if names is None else names)
    except Exception as e:                       # names are cosmetic: never sink the build
        print(f"[universe] short names failed: {type(e).__name__}: {e}", flush=True)

    out = {"v": V, "ts": round(now, 1), "fresh": bool(fresh),
            "counts": {"total": len(bodies), "up": up,
                       "down": sum(1 for b in bodies if b["status"] == "down"),
                       "new": sum(1 for b in bodies if b["new"]),
                       "lab": sum(1 for b in bodies if b.get("lab")),
                       # counts.down split by why (sums to counts.down): only "offline" is an outage
                       "down_by": {k: sum(1 for b in bodies if b["status"] == "down" and b.get("down_why") == k)
                                   for k in ("offline", "stopped", "gone")},
                       "by_class": dict(sorted(by_class.items()))},
            "systems": systems, "bodies": bodies, "links": links,
            "excluded": list(excluded or [])}
    if degraded:
        out["degraded"] = degraded
    if traffic is not None:
        try:
            mac_bid, ip_bid = {}, {}
            for bid, o, _rec in resolved:
                for m in list(o.macs) + list(o.m.get("chassis_macs") or []):
                    mac_bid.setdefault(str(m).lower(), bid)
                for ip in _claim_ips(o):
                    ip_bid.setdefault(ip, bid)
            out["traffic"] = traffic_doc(traffic["state"], now, bodies, systems, mac_bid, ip_bid, topo_to_body,
                                         topo=topo, tunnels=traffic.get("tunnels"))
        except Exception as e:                   # absent rather than wrong
            print(f"[universe] traffic failed: {type(e).__name__}: {e}", flush=True)
    return out


def _anchors(bodies, topo_nodes):
    """System -> the topology id of its hub: the gateway for the core, the first
    switch for home, the Proxmox host for its galaxy, and for a site its own
    gateway / network device, else the remote NVR, else the core gateway."""
    kinds = {}
    for n in topo_nodes:
        kinds.setdefault(n.get("kind"), []).append(n.get("id"))
    gw = (kinds.get("gateway") or [None])[0]
    sw = (kinds.get("switch") or [None])[0]
    out = {"sys:core": gw, "sys:home": sw or gw}
    meta = {n.get("id"): n.get("meta") or {} for n in topo_nodes}
    for pid in kinds.get("pvehost") or []:
        # a hub node may name the system it anchors (k8s.py's cluster hubs: meta.anchor_of)
        out[meta.get(pid, {}).get("anchor_of") or "sys:" + pid.split(":", 1)[1]] = pid
    for sid, _label, _net, _accent in _site_defs():
        hub = next((b.get("topo") for b in bodies if b["system"] == sid
                    and b["class"] in ("gateway", "network_device", "switch") and b.get("topo")), None)
        nvr = next((b.get("topo") for b in bodies if b["system"] == sid
                    and b["class"] == "storage" and b.get("topo")), None)
        out[sid] = hub or nvr or gw
    return {k: v for k, v in out.items() if v}


def _extra_system_def(sid):
    """Label/kind/accent for systems owned by an optional feed module (k8s.py:
    "sys:k8s-<cluster>", kind "k8s"). Kept by prefix even when the module is gone,
    so a held cluster never turns into a Proxmox galaxy."""
    if not str(sid).startswith("sys:k8s-"):
        return None
    mod = sys.modules.get("k8s")
    fn = getattr(mod, "system_def", None) if mod is not None else None
    d = fn(sid) if fn else None
    return d or {"label": sid[len("sys:k8s-"):], "kind": "k8s", "accent": system_accent(sid)}


# ---- new systems: a deliberate accent, not a raw hash colour ---------------------------
_BUILTIN_HUES = (248.0, 35.0, 195.0, 140.0, 0.0, 205.0)   # the default accents' hues (core, nodes, home, sites)


def system_accent(sid):
    """Accent for a system with no configured accent (e.g. a new Proxmox node). Depends
    on the id only, so it never changes when other systems come and go; the hue keeps
    clear of the default galaxy accents and saturation/lightness match their palette."""
    h = hash32(sid)
    hue = float(h % 360)
    for _ in range(12):
        if all(min(abs(hue - b), 360.0 - abs(hue - b)) >= 22.0 for b in _BUILTIN_HUES):
            break
        hue = (hue + 37.0) % 360.0
    s, lt = 0.78, 0.66
    c = (1.0 - abs(2.0 * lt - 1.0)) * s
    x = c * (1.0 - abs((hue / 60.0) % 2.0 - 1.0))
    m = lt - c / 2.0
    r, g, b = [(c, x, 0.0), (x, c, 0.0), (0.0, c, x), (0.0, x, c), (x, 0.0, c), (c, 0.0, x)][int(hue // 60) % 6]
    return "#{:02x}{:02x}{:02x}".format(*tuple(int(round((v + m) * 255)) for v in (r, g, b)))


# ---- inter-system traffic (CONTRACTS section 6) --------------------------------------
# Sources, all measured, none of them new polling except one Zabbix call a minute:
#   unifi_port  switch/gateway port byte counters (topology's stat/device, in memory):
#               the cable between the core and a whole system (a Proxmox host's trunk
#               port) or a single client. Direction measured.
#   unifi_sta   per-client byte counters (stat/sta: wired-* / wireless): a client's
#               traffic to the core where its port is shared. Direction measured. On a
#               USW port UniFi only counts what the gateway routes, so these are never
#               used where the whole port is measured.
#   unifi_wan   the gateway's WAN counters -> traffic.wan for the core.
#   flow        ntopng conversations on the capture interface (topology flows): pairs
#               between non-core systems. No byte direction; the flow list is capped to
#               the busiest flows, so a flow-layer pair is a lower bound ("partial").
#   snmp        site-to-site tunnel interfaces (UNIVERSE_TUNNELS), polled by Zabbix:
#               the core<->site and site<->site links. Direction measured.
# Deliberately NOT used: Proxmox netin/netout (includes traffic that never leaves the
# host, so it cannot be attributed to a pair) and UniFi `*-r` rates (client rates can
# read 0 while the counters move).
TRAFFIC_WINDOW_S = 30.0       # EWMA time constant (seconds)
TRAFFIC_SAMPLE_S = 5.0        # sampler cadence; in-memory reads only
TRAFFIC_IDLE_S = 75.0         # counters flat this long while their reporter keeps reporting = measured idle
TRAFFIC_HOLD_S = {"port": 120.0, "sta": 120.0, "wan": 60.0, "flow": 30.0, "tun": 420.0}
TRAFFIC_PRUNE_S = 900.0
TRAFFIC_GONE_S = 30.0         # a client missing from the station list this long stops counting
TRAFFIC_TOP_N = 5
KIND_SHARE = 0.6              # a pair takes a contributor kind only when it carries >= 60 %
TRAFFIC_PATH = os.environ.get("UNIVERSE_TRAFFIC") or os.path.join(_UDIR, "universe_traffic.json")
_GW_TYPES = ("udm", "uxg", "ugw", "usg", "udr")
_FEED_OF = {"port": "unifi", "sta": "unifi", "wan": "unifi", "flow": "flow", "tun": "snmp"}
# Site-to-site tunnels: a gateway interface Zabbix polls over SNMP and the two systems
# it joins. Not discoverable (UniFi names site-to-site WireGuard interfaces wgsts<N> and
# its API reports no byte counters for them), so declared in UNIVERSE_TUNNELS
# (config.py) or as {"tunnels": [...]} in TRAFFIC_PATH, which wins when present.
TUNNELS = list(config.UNIVERSE_TUNNELS or [])
_tunnels_cache = {"mtime": None, "list": TUNNELS}
_PROTO_KIND = (("storage", ("nfs", "smb", "cifs", "iscsi", "ceph", "9p", "afp", "rsync")),
               ("media", ("rtsp", "rtp", "rtmp", "hls", "srt", "plex", "emby", "jellyfin", "dlna", "upnp-av")),
               ("vpn", ("wireguard", "openvpn", "ipsec", "tailscale", "zerotier", "l2tp", "gre", "ike")))


def load_tunnels(path=None):
    """TUNNELS, or the list in TRAFFIC_PATH when that file exists and parses."""
    path = path or TRAFFIC_PATH
    try:
        mt = os.path.getmtime(path)
    except OSError:
        _tunnels_cache.update(mtime=None, list=TUNNELS)
        return TUNNELS
    if mt != _tunnels_cache["mtime"]:
        lst = TUNNELS
        try:
            with open(path) as f:
                d = json.load(f)
            cand = [t for t in (d.get("tunnels") or []) if isinstance(t, dict)
                    and all(isinstance(t.get(k), str) and t[k] for k in ("host", "if", "local", "remote"))]
            lst = cand if "tunnels" in d else TUNNELS
        except Exception as e:
            print(f"[universe] {path} unreadable, using built-in tunnels: {type(e).__name__}: {e}", flush=True)
        _tunnels_cache.update(mtime=mt, list=lst)
    return _tunnels_cache["list"]


def _num(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def _public_ip(ip):
    try:
        a = ipaddress.ip_address(str(ip))
    except ValueError:
        return False
    return a.is_global and not a.is_multicast


class TrafficState:
    """Per-key EWMA of measured rates in bits/s, fed by traffic_sample().

    ("port", switch mac, idx), ("sta", client mac) and ("wan", gateway mac, iface) are
    cumulative byte counters, differenced here between reports and timed by the
    reporter's own last_seen: a UniFi switch refreshes its counters every ~20-40 s,
    so differencing on a fixed 5 s beat would alternate 0 and double. ("flow", src ip,
    dst ip) and ("tun", host, ifname) arrive as rates already (ntopng, Zabbix). A key
    is reported only while fresh (TRAFFIC_HOLD_S); nothing decays toward a made-up 0,
    and a reset counter re-baselines instead of spiking."""

    def __init__(self, tau=TRAFFIC_WINDOW_S):
        self.tau = float(tau)
        self.k = {}
        self.attach = {}          # client mac -> {"wired", "sw_mac", "sw_port", "ap_mac", "ip", "at"}
        self.gw = None
        self.flow_ts = None
        self.lock = threading.RLock()

    def _apply(self, r, vals, dt, now):
        a = 1.0 if self.tau <= 0 else 1.0 - math.exp(-max(dt, 0.0) / self.tau)
        if r.get("e") is None:
            r["e"] = [float(v) for v in vals]
        else:
            r["e"] = [e + a * (float(v) - e) for e, v in zip(r["e"], vals, strict=False)]
        r["upd"] = now

    def counter(self, key, t, rx, tx, now):
        r = self.k.get(key)
        if r is None:
            self.k[key] = {"t": t, "c": (rx, tx), "e": None, "upd": None, "obs": now}
            return
        r["obs"] = now
        if rx < r["c"][0] or tx < r["c"][1]:          # reset / wrap / reboot: re-baseline
            r["t"], r["c"] = t, (rx, tx)
            return
        dt = t - r["t"]
        if (rx, tx) == r["c"]:
            if dt >= TRAFFIC_IDLE_S:                  # its reporter kept reporting: measured idle
                self._apply(r, (0.0, 0.0), dt, now)
                r["t"] = t
            return
        if dt < 1.0:                                  # moved but the clock did not: wait, lossless
            return
        self._apply(r, ((rx - r["c"][0]) * 8.0 / dt, (tx - r["c"][1]) * 8.0 / dt), dt, now)
        r["t"], r["c"] = t, (rx, tx)

    def rate(self, key, t, vals, now, attrs=None):
        r = self.k.get(key)
        if r is None:
            r = self.k[key] = {"t": t, "e": None, "upd": None}
            self._apply(r, vals, 0.0, now)
        elif t > r["t"]:
            self._apply(r, vals, t - r["t"], now)
            r["t"] = t
        r["obs"] = now
        if attrs is not None:
            r["attrs"] = attrs

    def snapshot(self, now):
        """(fresh rates {key: {"e", "attrs", "upd"}}, client attachments, gateway mac)."""
        with self.lock:
            out = {}
            for key, r in self.k.items():
                if r.get("e") is None or r.get("upd") is None:
                    continue
                if now - r["upd"] > TRAFFIC_HOLD_S.get(key[0], 60.0):
                    continue
                out[key] = {"e": list(r["e"]), "attrs": dict(r.get("attrs") or {}), "upd": r["upd"]}
            return out, dict(self.attach), self.gw

    def prune(self, now):
        with self.lock:
            stale = [k for k, r in self.k.items()
                     if now - max(r.get("upd") or 0.0, r.get("obs") or 0.0) > TRAFFIC_PRUNE_S]
            for k in stale:
                del self.k[k]
            for mac in [m for m, a in self.attach.items() if now - a.get("at", 0.0) > TRAFFIC_PRUNE_S]:
                del self.attach[mac]
            if len(self.k) > 6000:                     # bounded, whatever the feeds do
                for k in sorted(self.k, key=lambda k: self.k[k].get("obs") or 0.0)[:len(self.k) - 6000]:
                    del self.k[k]
            return len(stale)


def traffic_sample(state, now, devices=None, stas=None, topo=None, tunnels=None):
    """Feed one look at already-fetched state into `state`. No I/O.

    devices: UniFi stat/device rows; stas: UniFi stat/sta rows; topo: DATA["topology"]
    (flows + flow_meta); tunnels: {(host, ifname): {"in", "out", "clock", "delay"}}."""
    with state.lock:
        for d in devices or []:
            mac = str(d.get("mac") or "").lower()
            t = _num(d.get("last_seen"))
            if not mac or t is None:
                continue
            if str(d.get("type") or "").lower().startswith(_GW_TYPES):
                state.gw = mac
                wans = [(k, d[k]) for k in ("wan1", "wan2", "wan3", "wan4") if isinstance(d.get(k), dict)
                        and d[k].get("up") is not False
                        and _num(d[k].get("rx_bytes")) is not None and _num(d[k].get("tx_bytes")) is not None]
                if not wans and isinstance(d.get("uplink"), dict) and _num(d["uplink"].get("rx_bytes")) is not None:
                    wans = [("uplink", d["uplink"])]
                for k, w in wans:              # one key per WAN: a second WAN coming up never spikes
                    state.counter(("wan", mac, k), t, _num(w.get("rx_bytes")), _num(w.get("tx_bytes")), now)
            for p in d.get("port_table") or []:
                idx = p.get("port_idx")
                rx, tx = _num(p.get("rx_bytes")), _num(p.get("tx_bytes"))
                if idx is None or rx is None or tx is None or p.get("up") is False:
                    continue
                state.counter(("port", mac, idx), t, rx, tx, now)
        for c in stas or []:
            mac = str(c.get("mac") or "").lower()
            if not mac:
                continue
            wired = bool(c.get("is_wired"))
            state.attach[mac] = {"wired": wired, "sw_mac": str(c.get("sw_mac") or "").lower() or None,
                                 "sw_port": c.get("sw_port"), "ap_mac": str(c.get("ap_mac") or "").lower() or None,
                                 "ip": str(c["ip"]) if c.get("ip") else None, "at": now}
            t = _num(c.get("last_seen"))
            rx = _num(c.get("wired-rx_bytes" if wired else "rx_bytes"))
            tx = _num(c.get("wired-tx_bytes" if wired else "tx_bytes"))
            if t is not None and rx is not None and tx is not None:
                state.counter(("sta", mac), t, rx, tx, now)
        meta = (topo or {}).get("flow_meta") or {}
        fts = _num(meta.get("ts"))
        if meta.get("up") and fts is not None and fts != state.flow_ts and now - fts <= TRAFFIC_HOLD_S["flow"]:
            state.flow_ts = fts
            for f in (topo or {}).get("flows") or []:
                bps = _num(f.get("bps"))
                if not f.get("measured") or bps is None:
                    continue
                key = ("flow", str(f.get("src_ip") or ""), str(f.get("dst_ip") or ""))
                state.rate(key, fts, (bps,), now,
                           attrs={"src": f.get("src"), "dst": f.get("dst"), "proto": f.get("proto"),
                                  "internal": bool(f.get("internal")),
                                  "src_label": f.get("src_label"), "dst_label": f.get("dst_label")})
        for (host, ifn), v in (tunnels or {}).items():
            clk, i, o = _num(v.get("clock")), _num(v.get("in")), _num(v.get("out"))
            if clk is None or i is None or o is None:
                continue
            if now - clk > 2.0 * (_num(v.get("delay")) or 180.0) + 60.0:
                continue                                # Zabbix stopped polling it: not a live value
            state.rate(("tun", host, ifn), clk, (i, o), now)


def _body_kind(b):
    b = b or {}
    cls, cat = b.get("class"), b.get("cat")
    lab = f"{b.get('label') or ''} {b.get('short') or ''}".lower()
    if "backup" in lab or re.search(r"\bpbs\b", lab):
        return "backup"
    if cls in ("camera", "tv_av", "game_console") or cat == "media":
        return "media"
    if cls == "storage" or re.search(r"\b(nas|truenas|minio)\b", lab):
        return "storage"
    if re.search(r"wireguard|tailscale|openvpn|\bvpn\b", lab):
        return "vpn"
    return "lan"


def _proto_is(proto, keys):
    """Whole-token match ("PostgreSQL" is not GRE; "HTTP.WebSocket" is HTTP)."""
    toks = [t for t in re.split(r"[^a-z0-9]+", str(proto or "").lower()) if t]
    return any(t == k or t.startswith(k) for t in toks for k in keys)


def _flow_kind(proto, *ends):
    if any(_body_kind(b) == "backup" for b in ends if b):
        return "backup"
    for kind, keys in _PROTO_KIND:
        if _proto_is(proto, keys):
            return kind
    return "lan"


def _dominant_kind(cs):
    tot = sum(c["bps"] for c in cs)
    by = {}
    for c in cs:
        by[c["kind"]] = by.get(c["kind"], 0.0) + c["bps"]
    if tot > 0:
        k, v = max(sorted(by.items()), key=lambda kv: kv[1])
        return k if v / tot >= KIND_SHARE else "mixed"
    kinds = set(by)
    return kinds.pop() if len(kinds) == 1 else "mixed"


def _r(x):
    return round(float(x), 1)


def traffic_doc(state, now, bodies, systems, mac_bid, ip_bid, topo_bid, topo=None, tunnels=None,
                window_s=TRAFFIC_WINDOW_S):
    """The `traffic` object (CONTRACTS section 6) from the state's fresh keys.

    A pair's total comes from ONE measurement layer: "interface" contributors (ports,
    clients on shared ports, tunnels) when it has any, else "flow" conversations
    (then `partial`: ntopng sees its capture interface only, busiest flows only).
    Contributors of the other layer, and per-client counters on a port that is
    measured whole, appear in `top` only, so nothing is counted twice."""
    rates, attach, gw = state.snapshot(now)
    B = {b["id"]: b for b in bodies}
    known = {s["id"] for s in systems}

    def sysof(bid):
        return (B.get(bid) or {}).get("system") if bid else None

    def name(bid, fallback=None):
        b = B.get(bid) or {}
        return b.get("short") or b.get("label") or fallback or bid or "?"

    on_port = {}
    for mac, at in attach.items():
        if at.get("wired") and at.get("sw_mac") and at.get("sw_port") is not None:
            on_port.setdefault((at["sw_mac"], at["sw_port"]), []).append(mac)
    pve_ip = {str(n.get("ip")): n.get("id") for n in (topo or {}).get("nodes") or []
              if n.get("kind") == "pvehost" and n.get("ip")}
    trunk = {}                                   # (switch mac, port) -> the hypervisor's body
    for mac, at in attach.items():
        if at.get("wired") and at.get("ip") in pve_ip and at.get("sw_mac") and at.get("sw_port") is not None:
            hb = topo_bid.get(pve_ip[at["ip"]]) or mac_bid.get(mac)
            if hb:
                trunk[(at["sw_mac"], at["sw_port"])] = hb

    pairs = {}

    def add(s1, b1, s2, b2, bps, d12, d21, kind, label, src, layer):
        if not s1 or not s2 or s1 == s2 or bps is None:
            return
        if s2 < s1:
            s1, b1, s2, b2, d12, d21 = s2, b2, s1, b1, d21, d12
        c = {"a": b1, "b": b2, "bps": max(0.0, bps), "kind": kind, "label": label, "src": src, "layer": layer}
        if d12 is not None and d21 is not None:
            c["a_to_b_bps"], c["b_to_a_bps"] = max(0.0, d12), max(0.0, d21)
        pairs.setdefault((s1, s2), []).append(c)

    # ports measured whole: a hypervisor's trunk, or a port whose clients all belong to
    # one system (and none is a hub). Decided from the client table, not from whether
    # the port counter is fresh yet, so a client never switches measurement mid-stream.
    whole = {}
    for port, macs in on_port.items():
        if port in trunk:
            whole[port] = trunk[port]
            continue
        bids = sorted({mac_bid.get(m) for m in macs} - {None})
        if bids and len({sysof(b) for b in bids}) == 1 and not any((B.get(b) or {}).get("hub") for b in bids):
            whole[port] = bids[0]
    for key, v in sorted(rates.items(), key=lambda kv: str(kv[0])):
        if key[0] != "port" or (key[1], key[2]) not in whole:
            continue
        _, dev, idx = key
        db, tb = mac_bid.get(dev), whole[(dev, idx)]
        ds, ts = sysof(db), sysof(tb)
        if not ds or not ts or ts == ds:
            continue
        rx, tx = v["e"]                           # rx: into the switch from that side; tx: out to it
        n = len(on_port.get((dev, idx)) or [])
        more = "" if (dev, idx) in trunk or n < 2 else f" +{n - 1}"
        add(ds, db, ts, tb, rx + tx, tx, rx, "lan" if (dev, idx) in trunk else _body_kind(B.get(tb)),
            f"{name(db)} port {idx} ⇄ {name(tb)}{more}", "unifi_port", "interface")

    for key, v in rates.items():
        if key[0] != "sta":
            continue
        mac = key[1]
        at = attach.get(mac) or {}
        if now - at.get("at", 0.0) > TRAFFIC_GONE_S:
            continue                              # left the network: its last rate is not live
        bid = mac_bid.get(mac)
        dev = at.get("sw_mac") if at.get("wired") else at.get("ap_mac")
        db = mac_bid.get(dev) if dev else None
        ss, ds = sysof(bid), sysof(db)
        if not ss or not ds or ss == ds:
            continue
        rx, tx = v["e"]                           # rx: from the client; tx: to the client
        port = (at.get("sw_mac"), at.get("sw_port")) if at.get("wired") else None
        if port in whole:
            # the port is measured whole: its own counters are the number; a client's
            # counters only break a shared port down (a lone client would repeat it)
            if port in trunk or len(on_port.get(port) or []) > 1:
                add(ds, db, ss, bid, rx + tx, tx, rx, _body_kind(B.get(bid)), f"{name(bid)} (client)",
                    "unifi_sta", "detail")
        else:
            add(ds, db, ss, bid, rx + tx, tx, rx, _body_kind(B.get(bid)), f"{name(bid)} ⇄ {name(db)}",
                "unifi_sta", "interface")

    wan_flows = {}
    for key, v in rates.items():
        if key[0] != "flow":
            continue
        at, bps = v["attrs"], v["e"][0]
        sb, dbb = topo_bid.get(at.get("src")), topo_bid.get(at.get("dst"))
        proto = str(at.get("proto") or "")
        if at.get("internal"):
            if sb and dbb:
                add(sysof(sb), sb, sysof(dbb), dbb, bps, None, None, _flow_kind(proto, B.get(sb), B.get(dbb)),
                    f"{name(sb)} ⇄ {name(dbb)} {proto}".strip(), "flow", "flow")
            continue
        inside, ext, ext_label = (sb, key[2], at.get("dst_label")) if sb else (dbb, key[1], at.get("src_label"))
        if inside and sysof(inside) and _public_ip(ext):
            kind = "vpn" if _proto_is(proto, _PROTO_KIND[2][1]) else "wan"
            wan_flows.setdefault(sysof(inside), []).append(
                {"a": inside, "b": None, "bps": max(0.0, bps), "kind": kind, "src": "flow",
                 "label": f"{name(inside)} ⇄ {ext_label or ext} {proto}".strip()})

    for t in tunnels or []:
        v = rates.get(("tun", t.get("host"), t.get("if")))
        if not v:
            continue
        inn, out = v["e"]                         # in: remote -> local; out: local -> remote
        add(t.get("local"), ip_bid.get(t.get("local_ip")), t.get("remote"), ip_bid.get(t.get("remote_ip")),
            inn + out, out, inn, "vpn", t.get("label") or f"{t.get('host')} {t.get('if')}", "snmp", "interface")

    def top_entry(c):
        e = {"a": c["a"], "b": c["b"], "bps": _r(c["bps"]), "kind": c["kind"], "label": c["label"], "src": c["src"]}
        if "a_to_b_bps" in c:
            e["a_to_b_bps"], e["b_to_a_bps"] = _r(c["a_to_b_bps"]), _r(c["b_to_a_bps"])
        return e

    out_pairs = []
    for (a, b) in sorted(pairs):
        if a not in known or b not in known:
            continue
        cs = pairs[(a, b)]
        layer = "interface"
        tot = [c for c in cs if c["layer"] == "interface"]
        if not tot:
            layer, tot = "flow", [c for c in cs if c["layer"] == "flow"]
        if not tot:
            continue                               # breakdown only: the pair itself is unmeasured
        e = {"a": a, "b": b, "bps": _r(sum(c["bps"] for c in tot))}
        if all("a_to_b_bps" in c for c in tot):
            e["a_to_b_bps"] = _r(sum(c["a_to_b_bps"] for c in tot))
            e["b_to_a_bps"] = _r(sum(c["b_to_a_bps"] for c in tot))
        e["kind"] = _dominant_kind(tot)
        e["links"] = len(tot)
        e["layer"] = layer
        if layer == "flow":
            e["partial"] = True
        e["top"] = [top_entry(c) for c in sorted(cs, key=lambda c: (-c["bps"], c["label"]))
                    if c["bps"] >= 1.0][:TRAFFIC_TOP_N]
        e["src"] = sorted({c["src"] for c in tot})
        out_pairs.append(e)

    wan = []
    gb = mac_bid.get(gw) if gw else None
    wk = [v for k, v in rates.items() if k[0] == "wan" and k[1] == gw]
    if gb and wk and sysof(gb) in known:
        isp = next((n.get("label") for n in (topo or {}).get("nodes") or [] if n.get("kind") == "wan"), None)
        rx, tx = sum(v["e"][0] for v in wk), sum(v["e"][1] for v in wk)
        wan.append({"system": sysof(gb), "in_bps": _r(rx), "out_bps": _r(tx), "bps": _r(rx + tx),
                    "via": isp or "WAN", "layer": "interface", "src": ["unifi_wan"]})
    for s in sorted(wan_flows):
        if s not in known:
            continue
        fl = sorted(wan_flows[s], key=lambda c: (-c["bps"], c["label"]))
        tot = sum(c["bps"] for c in fl)
        best = {}
        for c in fl:
            best[c["a"]] = best.get(c["a"], 0.0) + c["bps"]
        lead, lead_bps = max(sorted(best.items()), key=lambda kv: kv[1])
        wan.append({"system": s, "bps": _r(tot), "via": name(lead) if tot > 0 and lead_bps / tot >= KIND_SHARE else "mixed",
                    "layer": "flow", "partial": True, "src": ["flow"],
                    "top": [top_entry(c) for c in fl if c["bps"] >= 1.0][:TRAFFIC_TOP_N]})

    feeds = {}
    for key, v in rates.items():
        f = feeds.setdefault(_FEED_OF.get(key[0], key[0]), {"keys": 0, "age_s": None})
        f["keys"] += 1
        age = round(max(0.0, now - v["upd"]), 1)
        f["age_s"] = age if f["age_s"] is None else min(f["age_s"], age)
    return {"ts": round(now, 1), "window_s": window_s, "pairs": out_pairs, "wan": wan, "sources": feeds}


# ---- Zabbix: tunnel interface rates + the lab host group (read-only) -------------------
ZBX_URL = config.ZBX_URL
ZBX_POLL_S = 60.0
ZBX_RESOLVE_S = 1800.0
ZBX_BACKOFF_S = 900.0
LAB_GROUPS = list(config.UNIVERSE_LAB_GROUPS or [])
_IF_ITEM = re.compile(r"^Interface (\S+?)\(.*\): Bits (received|sent)$")


class ZbxError(RuntimeError):
    pass


def _post_json(url, payload, headers, timeout=10):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _delay_s(v, default=180.0):
    m = re.match(r"^\s*(\d+)\s*([smhd]?)\s*$", str(v or ""))
    if not m:
        return default
    return float(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)]


class ZabbixFeed:
    """One reused API session. A rejected login backs off ZBX_BACKOFF_S, so this can
    never lock out the account the rest of the dashboard logs in with. Nothing here
    writes to Zabbix; every call is a *.get (plus user.login)."""

    def __init__(self, url, user, password, post=None):
        self.url, self.user, self.password = url, user, password
        self.post = post or _post_json
        self.token = None
        self.block_until = 0.0
        self.items = {}              # itemid -> (host, ifname, "in"|"out", delay_s)
        self.resolved_at = 0.0
        self.values = {}             # (host, ifname) -> {"in", "out", "clock", "delay"}
        self.lab_ips, self.lab_at = set(), 0.0
        self.err, self.ok_at = None, 0.0
        self.lock = threading.Lock()

    def _raw(self, method, params, auth=True):
        h = {"Content-Type": "application/json-rpc"}
        if auth and self.token:
            h["Authorization"] = "Bearer " + self.token
        j = self.post(self.url, {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}, h)
        if "error" in j:
            e = j["error"] or {}
            raise ZbxError(f"{method}: {e.get('message')} {e.get('data') or ''}".strip()[:200])
        return j.get("result")

    def _login(self, now):
        if now < self.block_until:
            raise ZbxError("login backing off after a rejected attempt")
        try:
            self.token = self._raw("user.login", {"username": self.user, "password": self.password}, auth=False)
        except Exception:
            self.token, self.block_until = None, now + ZBX_BACKOFF_S
            raise

    def call(self, method, params, now):
        if not self.token:
            self._login(now)
        try:
            return self._raw(method, params)
        except ZbxError as e:
            msg = str(e).lower()
            if "session" in msg or "re-login" in msg or "not authori" in msg:
                self.token = None
                self._login(now)
                return self._raw(method, params)
            raise

    def _resolve(self, now, tunnels):
        hosts = sorted({t["host"] for t in tunnels})
        ifs = sorted({t["if"] for t in tunnels})
        items = {}
        if hosts:
            hs = self.call("host.get", {"output": ["hostid", "host"], "filter": {"host": hosts}}, now) or []
            byid = {h["hostid"]: h["host"] for h in hs}
            if byid:
                rows = self.call("item.get", {"hostids": sorted(byid), "output": ["itemid", "hostid", "name", "key_", "delay"],
                                              "search": {"name": ifs}, "searchByAny": True, "monitored": True}, now) or []
                want = {(t["host"], t["if"]) for t in tunnels}
                for it in rows:
                    m = _IF_ITEM.match(str(it.get("name") or ""))
                    if not m or not str(it.get("key_") or "").startswith(("net.if.in[", "net.if.out[")):
                        continue
                    host = byid.get(it.get("hostid"))
                    if (host, m.group(1)) in want:
                        items[it["itemid"]] = (host, m.group(1), "in" if m.group(2) == "received" else "out",
                                               _delay_s(it.get("delay")))
        self.items, self.resolved_at = items, now

    def _lab(self, now):
        ips = set()
        if LAB_GROUPS:
            gs = self.call("hostgroup.get", {"output": ["groupid"], "filter": {"name": LAB_GROUPS}}, now) or []
            if gs:
                hs = self.call("host.get", {"output": ["hostid"], "groupids": [g["groupid"] for g in gs],
                                            "selectInterfaces": ["ip"]}, now) or []
                for h in hs:
                    for i in h.get("interfaces") or []:
                        if i.get("ip") and _ip_ok(i["ip"]):
                            ips.add(str(i["ip"]))
        self.lab_ips, self.lab_at = ips, now

    def poll(self, now, tunnels):
        try:
            if not self.items or now - self.resolved_at > ZBX_RESOLVE_S:
                self._resolve(now, tunnels)
            vals = {}
            if self.items:
                rows = self.call("item.get", {"itemids": sorted(self.items), "output": ["itemid", "lastvalue", "lastclock"]}, now) or []
                for it in rows:
                    host, ifn, d, delay = self.items.get(it.get("itemid"), (None, None, None, None))
                    clk, v = _num(it.get("lastclock")), _num(it.get("lastvalue"))
                    if host is None or not clk or v is None:
                        continue
                    slot = vals.setdefault((host, ifn), {"delay": delay})
                    slot[d], slot["clock_" + d] = v, clk
                if len(rows) < len(self.items):
                    self.resolved_at = 0.0             # an item vanished (LLD re-keyed it): resolve again
            out = {}
            for k, s in vals.items():
                if "in" in s and "out" in s and abs(s["clock_in"] - s["clock_out"]) <= s["delay"]:
                    out[k] = {"in": s["in"], "out": s["out"], "clock": max(s["clock_in"], s["clock_out"]), "delay": s["delay"]}
            if now - self.lab_at > ZBX_RESOLVE_S:
                self._lab(now)
            with self.lock:
                self.values = out
            self.err, self.ok_at = None, now
        except Exception as e:
            self.err = f"{type(e).__name__}: {e}"[:200]
            raise

    def tunnel_values(self):
        with self.lock:
            return dict(self.values)

    def lab_set(self, now):
        return set(self.lab_ips) if now - self.lab_at <= 3 * ZBX_RESOLVE_S else set()


# ---- in-process wiring ------------------------------------------------------------
_store = None
_cache = {"at": 0.0, "body": None}
_build_lock = threading.Lock()
_last_excluded = [None]


def _topology_module():
    return sys.modules.get("topology")


_deg = {"until": 0.0, "why": None, "sta": []}


def degraded_state(DATA, tm, now, warm_gave_up=False):
    """Reason string when the feeds are thin enough that an IP-only sighting can't
    be trusted to be a NEW device, else None. Stays set DEGRADED_GRACE_S after the
    last signal: UniFi answers a short station list for minutes after it recovers."""
    why = []
    if warm_gave_up:
        why.append("warming gate gave up")
    topo = DATA.get("topology") or {}
    gw = next((n for n in topo.get("nodes") or [] if n.get("kind") == "gateway"), None)
    if gw is not None and gw.get("status") == "unknown":
        why.append("unifi devices stale")
    if tm is not None:
        stale = (getattr(tm, "_pve_state", None) or {}).get("stale_nodes") or []
        if stale:
            why.append("proxmox stale: " + ",".join(sorted(stale)))
        stas = getattr(tm, "_last_stas", None)
        if stas is not None:
            hist = [(t, n) for t, n in _deg["sta"] if now - t <= STA_WINDOW_S]
            hist.append((now, len(stas)))
            _deg["sta"] = hist[-400:]
            peak = max(n for _, n in hist)
            if peak and len(stas) < STA_DIP * peak:
                why.append(f"unifi station list short ({len(stas)} of {peak})")
    if why:
        _deg["until"], _deg["why"] = now + DEGRADED_GRACE_S, "; ".join(why)
        return _deg["why"]
    if now < _deg["until"]:
        return "recovering: " + (_deg["why"] or "")
    return None


def build_from_data(DATA, store_obj, now=None, warm_gave_up=False):
    now = now or time.time()
    topo = DATA.get("topology") or {}
    _node_hint[:] = [n.get("node") for n in DATA.get("nodes") or [] if n.get("node")]
    tm = _topology_module()
    stas = known = gmac = client_cat = devices = None
    gw_lan = ()
    if tm is not None:
        stas = getattr(tm, "_last_stas", None)
        known = (getattr(tm, "_known", None) or {}).get("rows")
        gmac = dict(getattr(tm, "_gmac", None) or {})
        client_cat = getattr(tm, "_client_cat", None)
        gw_lan = tuple(getattr(tm, "_gwip", None) or ())      # cached by topology; no fetch
        devices = getattr(tm, "_last_devices", None)
    excluded = []
    obs = observe(topo, DATA, gw_lan=gw_lan, stas=stas, known=known, gmac=gmac, excluded=excluded,
                  client_cat=client_cat, now=now, devices=devices, declared=load_declared(),
                  same=load_same())
    fresh = bool(topo.get("ts")) and (now - float(topo["ts"]) < FRESH_S)
    degraded = degraded_state(DATA, tm, now, warm_gave_up)
    k8s_held, k8s_names = (), {}
    try:                       # Kubernetes clusters (k8s.py): one system each, optional
        import k8s
        obs = obs + k8s.observations(Obs, now=now)
        topo = k8s.augment_topology(topo)
        k8s_held = k8s.unknown_systems()
        k8s_names = k8s.short_names()
    except Exception as e:
        print(f"[universe] k8s skipped: {type(e).__name__}: {e}", flush=True)
    res = build(obs, store_obj, now=now, fresh=fresh, topo=topo, excluded=excluded, degraded=degraded,
                traffic={"state": _traffic, "tunnels": load_tunnels()} if _sampler["running"] else None,
                lab_ips=_zbx.lab_set(now) if _zbx is not None else None, unknown_systems=k8s_held,
                names=dict(k8s_names, **load_names()) if k8s_names else None)
    if _traffic_fn[0] is not None:               # demo mode: a synthetic traffic object
        try:
            res["traffic"] = _traffic_fn[0](res, now)
        except Exception as e:
            print(f"[universe] traffic hook failed: {type(e).__name__}: {e}", flush=True)
    sig = json.dumps(res.get("excluded") or [], sort_keys=True)
    if sig != _last_excluded[0]:                  # log on change, not every build
        _last_excluded[0] = sig
        for e in res.get("excluded") or []:
            print(f"[universe] excluded {e.get('feed')} {e.get('key')}: {e.get('reason')}", flush=True)
    return res


_traffic = TrafficState()
_traffic_fn = [None]


def set_traffic_fn(fn):
    """Replace the measured `traffic` object with fn(doc, now) (demo mode only)."""
    _traffic_fn[0] = fn


_zbx = None
_sampler = {"running": False}


def _traffic_loop(DATA):
    """Every TRAFFIC_SAMPLE_S: difference the counters topology already holds. In-memory
    only (no request leaves this thread), so it costs well under a millisecond."""
    last, n = None, 0
    while True:
        now = time.time()
        try:
            tm = _topology_module()
            traffic_sample(_traffic, now,
                           devices=getattr(tm, "_last_devices", None) if tm is not None else None,
                           stas=getattr(tm, "_last_stas", None) if tm is not None else None,
                           topo=DATA.get("topology"),
                           tunnels=_zbx.tunnel_values() if _zbx is not None else None)
            n += 1
            if n % 12 == 0:
                _traffic.prune(now)
            if last:
                print("[universe] traffic sampler recovered", flush=True)
            last = None
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:160]
            if msg != last:
                print(f"[universe] traffic sampler: {msg}", flush=True)
            last = msg
        time.sleep(TRAFFIC_SAMPLE_S)


def _zbx_loop():
    last = None
    while True:
        try:
            _zbx.poll(time.time(), load_tunnels())
            if last:
                print("[universe] zabbix feed recovered", flush=True)
            last = None
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:200]
            if msg != last:
                print(f"[universe] zabbix feed: {msg}", flush=True)
            last = msg
        time.sleep(ZBX_POLL_S)


def start_traffic(DATA):
    """Start the traffic sampler (and the Zabbix feed when the dashboard has its
    credentials). Idempotent."""
    global _zbx
    if _sampler["running"]:
        return
    user, pw = config.ZBX_USER, config.ZBX_PASS
    if ZBX_URL and user and pw and (TUNNELS or LAB_GROUPS or os.path.exists(TRAFFIC_PATH)):
        _zbx = ZabbixFeed(ZBX_URL, user, pw)
        threading.Thread(target=_zbx_loop, daemon=True, name="universe-zbx").start()
    threading.Thread(target=_traffic_loop, args=(DATA,), daemon=True, name="universe-traffic").start()
    _sampler["running"] = True


WARM_MAX_S = 240.0     # stop waiting for a feed that never publishes after this long


def warm_state(DATA, started, now=None, strict=False):
    """None when every upstream cache has published at least once, else a reason.
    Nothing is minted or persisted until then, so a restart cannot record a
    thinned-out first view (e.g. clients missing because UniFi has not answered yet)."""
    now = now or time.time()
    topo = DATA.get("topology") or {}
    if not topo.get("nodes"):
        return "topology not published"
    if now - started >= WARM_MAX_S and not strict:
        return None
    tm = _topology_module()
    # only wait for the feeds this install actually has configured
    if tm is not None and config.UNIFI_URL:
        if getattr(tm, "_last_stas", None) is None:
            return "unifi stations not fetched"
        if not (getattr(tm, "_known", None) or {}).get("at"):
            return "unifi known-client list not fetched"
        kt = (getattr(tm, "_known", None) or {}).get("at") or 0
        if float(topo.get("ts") or 0) < kt:
            return "topology not rebuilt since known-client fetch"
    if tm is not None and config.UNIFI_URL and not getattr(tm, "_gmac", None):
        return "guest MACs not resolved"
    if not any(n.get("kind") == "guest" for n in topo.get("nodes") or []):
        return "no proxmox guests yet"
    if config.ENABLE_PROBE and "unknown" not in (DATA.get("probe") or {}):
        return "probe sweep not published"
    if config.NETMAP_URL and not (DATA.get("netmap") or {}).get("devices"):
        return "netmap not published"
    return None


def install(app, DATA, store_path=None):
    """Register GET /api/universe. Builds lazily on request, cached CACHE_S."""
    global _store
    from flask import Response
    _store = Store(store_path or STORE_PATH)
    started = time.time()
    warm = {"ok": False}
    try:
        start_traffic(DATA)
    except Exception as e:                       # traffic is optional; the registry is not
        print(f"[universe] traffic not started: {type(e).__name__}: {e}", flush=True)

    @app.route("/api/universe")
    def api_universe():
        now = time.time()
        body = _cache["body"]
        if body is None or now - _cache["at"] >= CACHE_S:
            with _build_lock:
                if _cache["body"] is None or time.time() - _cache["at"] >= CACHE_S:
                    why = None if warm["ok"] else warm_state(DATA, started)
                    if why is None and not warm["ok"]:
                        warm["ok"] = True
                        # gave up waiting rather than every feed publishing: the first
                        # builds are degraded (no IP-only mints) until the grace passes
                        warm["gave_up"] = warm_state(DATA, started, strict=True) is not None
                        if warm["gave_up"]:
                            print("[universe] warming gate gave up; degraded build", flush=True)
                    if why is not None and _cache["body"] is None:
                        return Response(json.dumps({"v": V, "ts": now, "warming": why,
                                                    "counts": {"total": 0, "up": 0, "by_class": {}},
                                                    "systems": [], "bodies": [], "links": []}),
                                        mimetype="application/json",
                                        headers={"Cache-Control": "no-store"})
                    try:
                        res = build_from_data(DATA, _store, now=time.time(),
                                              warm_gave_up=warm.pop("gave_up", False))
                        _cache["body"] = json.dumps(res, separators=(",", ":"))
                        _cache["at"] = time.time()
                    except Exception as e:
                        print(f"[universe] build failed: {type(e).__name__}: {e}", flush=True)
                        if _cache["body"] is None:
                            raise
            body = _cache["body"]
        return Response(body, mimetype="application/json", headers={"Cache-Control": "no-store"})

    return api_universe
