"""snmp.py - a first-class SNMP device source for the galaxy dashboard.

The physical layer of the topology comes from UniFi: a switch, router or AP is
a real node with ports and uplinks only if the UniFi controller manages it.
Anything else - the Cisco in the rack, the MikroTik at the edge, the managed
TP-Link under the desk - was at best a leaf the prober found. This module
polls those devices DIRECTLY over SNMP, so any brand of managed gear gets the
same treatment without running LibreNMS or hand-maintaining a netmap JSON:

  1 IDENTITY   sysName / sysDescr / sysObjectID / sysUpTime.
  2 PORTS      the interface table: admin and oper status, speed, MAC, octet
               and error counters, differenced over time into a real rate.
  3 LINKS      LLDP (and CDP, for Cisco gear that speaks no LLDP): who is on
               the far end of each port, by chassis id, port id, system name
               and management address. topology.py turns that into uplinks
               and attachments, MERGING a neighbour that is already on the map
               (a UniFi switch, a Proxmox host, a probed host) rather than
               drawing it twice. The merge key is chassis MAC / port MAC /
               management address - never a display name.

COUNTERS WRAP. ifInOctets is 32 bits and rolls over every ~34 s on a busy
gigabit port; the 64-bit ifHCInOctets does not. HC is preferred wherever the
agent has it. Where only 32-bit counters exist, a reading is trusted only if
the port could not have wrapped more than once in the interval (speed x dt
< 2^32 bytes), because a second wrap is undetectable. A counter that went
backwards - wrap or reset - produces NO reading for that interval, never a
"corrected" one: a correction that is wrong is a fake gigabit on the wall.

HONESTY RULES (same as the rest of the codebase):
  * a device that did not answer is published up=false with the classified
    reason; its last-known ports stay for shape, flagged stale, with every
    rate and counter absent.
  * a rate that could not be measured is None and measured=false, never 0.
  * a port, neighbour or system value the agent did not return is absent.

SAFETY: only the targets the operator listed are ever contacted. There is no
discovery, no sweep and no community guessing. The target count is capped,
every request has an explicit timeout and retry count, every target has a
hard per-tick budget, and every failure degrades to "no data for that device"
rather than taking the poller down.

SECRETS: the community string and the v3 passphrases come from config only
(secret fields: masked in the wizard, absent from /api/config) and never
appear in anything this module publishes, logs or raises.

Optional: needs ``pysnmp`` 7.x (pure Python: ``pip install pysnmp``). SNMPv3
privacy (authPriv) additionally needs ``cryptography``. Without the library
the source reports "library missing" and nothing else changes.
"""
import asyncio
import threading
import time

import config
import topology

try:
    import pysnmp.hlapi.v3arch.asyncio as hlapi
    from pyasn1.type import univ
    from pysnmp.proto import errind, rfc1905
    LIB_ERR = None
    _AUTH = {"none": hlapi.USM_AUTH_NONE, "md5": hlapi.USM_AUTH_HMAC96_MD5, "sha": hlapi.USM_AUTH_HMAC96_SHA,
             "sha1": hlapi.USM_AUTH_HMAC96_SHA, "sha224": hlapi.USM_AUTH_HMAC128_SHA224,
             "sha256": hlapi.USM_AUTH_HMAC192_SHA256, "sha384": hlapi.USM_AUTH_HMAC256_SHA384,
             "sha512": hlapi.USM_AUTH_HMAC384_SHA512}
    _PRIV = {"none": hlapi.USM_PRIV_NONE, "des": hlapi.USM_PRIV_CBC56_DES, "3des": hlapi.USM_PRIV_CBC168_3DES,
             "aes": hlapi.USM_PRIV_CFB128_AES, "aes128": hlapi.USM_PRIV_CFB128_AES,
             "aes192": hlapi.USM_PRIV_CFB192_AES, "aes256": hlapi.USM_PRIV_CFB256_AES}
except Exception as _e:   # not installed, or a pysnmp older than 7 whose hlapi is laid out differently
    LIB_ERR = f"pysnmp 7.x is not installed ({type(_e).__name__}): pip install 'pysnmp>=7.1,<8'"
    _AUTH, _PRIV = {}, {}

TIMEOUT_S = 2.0           # per request attempt
RETRIES = 1               # so a request gives up after TIMEOUT_S * (RETRIES + 1)
TARGET_BUDGET_S = 45      # hard cap on one device per tick, whatever it is doing
MAX_TARGETS = 32
MAX_IFACES = 512
MAX_NEIGHBOURS = 256
BULK_REPS = 25
SLOW_S = 300              # structure (interface names, speeds, MACs) and neighbours
POLL_S = max(10, int(config.SNMP_POLL_S or 30))   # counters and status

DATA = {}
_rates = topology.RateTracker()   # private counter state, like the flow thread's
_dev = {}                         # host -> {"struct", "struct_ts", "last", "last_ts"}

# ---- OIDs (numeric: no MIB files, no resolver) ----
SYS_DESCR, SYS_OBJID, SYS_UPTIME, SYS_NAME = ("1.3.6.1.2.1.1.1.0", "1.3.6.1.2.1.1.2.0",
                                             "1.3.6.1.2.1.1.3.0", "1.3.6.1.2.1.1.5.0")
IF = "1.3.6.1.2.1.2.2.1."          # ifTable
IFX = "1.3.6.1.2.1.31.1.1.1."      # ifXTable
IF_STATIC = {"descr": IF + "2", "type": IF + "3", "speed": IF + "5", "mac": IF + "6",
             "name": IFX + "1", "high_speed": IFX + "15", "alias": IFX + "18"}
IF_LIVE = {"admin": IF + "7", "oper": IF + "8", "hc_in": IFX + "6", "hc_out": IFX + "10",
           "in_err": IF + "14", "out_err": IF + "20"}
IF_32 = {"in32": IF + "10", "out32": IF + "16"}
LLDP = "1.0.8802.1.1.2.1."
LLDP_LOC_CHASSIS_SUBTYPE, LLDP_LOC_CHASSIS_ID, LLDP_LOC_SYSNAME = LLDP + "3.1.0", LLDP + "3.2.0", LLDP + "3.3.0"
LLDP_LOC_PORT = {"subtype": LLDP + "3.7.1.2", "id": LLDP + "3.7.1.3", "descr": LLDP + "3.7.1.4"}
LLDP_REM = {"chassis_subtype": LLDP + "4.1.1.4", "chassis_id": LLDP + "4.1.1.5", "port_subtype": LLDP + "4.1.1.6",
            "port_id": LLDP + "4.1.1.7", "port_descr": LLDP + "4.1.1.8", "sys_name": LLDP + "4.1.1.9",
            "sys_descr": LLDP + "4.1.1.10"}
LLDP_REM_MAN_ADDR_IFID = LLDP + "4.2.1.4"
CDP = "1.3.6.1.4.1.9.9.23.1.2.1.1."
CDP_CACHE = {"addr_type": CDP + "3", "addr": CDP + "4", "device_id": CDP + "6", "port": CDP + "7",
             "platform": CDP + "8"}

OPER = {1: "up", 2: "down", 3: "testing", 4: "unknown", 5: "dormant", 6: "notPresent", 7: "lowerLayerDown"}
ADMIN = {1: "up", 2: "down", 3: "testing"}
# sysObjectID enterprise number -> vendor. A short table of the usual suspects;
# an unknown enterprise stays None rather than becoming a guess.
VENDORS = {9: "Cisco", 11: "HP", 171: "D-Link", 674: "Dell", 1916: "Extreme", 2011: "Huawei", 2636: "Juniper",
           3375: "F5", 4526: "Netgear", 6486: "Alcatel-Lucent", 8072: "net-snmp", 11863: "TP-Link",
           12356: "Fortinet", 14823: "Aruba", 14988: "MikroTik", 25506: "H3C", 41112: "Ubiquiti",
           4413: "Broadcom", 890: "Zyxel", 2021: "net-snmp", 30065: "Arista", 43356: "Nokia",
           52642: "FS", 44641: "pfSense/FreeBSD", 12325: "pfSense", 8741: "SonicWall", 14179: "Brocade"}
CHASSIS_TYPES = {1: "component", 2: "alias", 3: "port", 4: "mac", 5: "ip", 6: "ifname", 7: "local"}
PORT_TYPES = {1: "alias", 2: "component", 3: "mac", 4: "ip", 5: "ifname", 6: "circuit", 7: "local"}


class SnmpError(RuntimeError):
    """One classified failure. kind: timeout | auth | library | nosuch | error."""

    def __init__(self, kind, msg):
        super().__init__(msg)
        self.kind = kind


# ---------------- value decoding ----------------
def _py(v):
    """pyasn1 value -> plain Python. SNMP exception values (noSuchObject,
    noSuchInstance, endOfMibView) are None: the agent said it has no such
    thing, and None is how "absent" is spelled everywhere here."""
    if v is None:
        return None
    if isinstance(v, (rfc1905.NoSuchObject, rfc1905.NoSuchInstance, rfc1905.EndOfMibView, univ.Null)):
        return None
    if isinstance(v, univ.OctetString):
        return bytes(v)
    if isinstance(v, univ.ObjectIdentifier):
        return str(v)
    if isinstance(v, univ.Integer):
        return int(v)
    return str(v)


def _text(b, limit=200):
    if b is None:
        return None
    if isinstance(b, bytes):
        try:
            s = b.decode("utf-8").strip("\x00").strip()
        except UnicodeDecodeError:
            s = b.hex()
    else:
        s = str(b).strip()
    return s[:limit] or None


def _mac(b):
    if isinstance(b, bytes) and len(b) == 6:
        return ":".join(f"{x:02x}" for x in b)
    return None


def _ipv4(b):
    if isinstance(b, bytes) and len(b) == 4:
        return ".".join(str(x) for x in b)
    return None


def _decode_id(subtype, raw, table):
    """(value, type) for an LLDP chassis or port id by its subtype."""
    t = table.get(subtype, "other")
    if t == "mac":
        m = _mac(raw)
        return (m, "mac") if m else (_text(raw), "other")
    if t == "ip":                     # first octet is the address family (1 = IPv4)
        if isinstance(raw, bytes) and len(raw) == 5 and raw[0] == 1:
            return _ipv4(raw[1:]), "ip"
        if isinstance(raw, bytes) and len(raw) == 4:
            return _ipv4(raw), "ip"
        return _text(raw), "other"
    return _text(raw), t


def _vendor(objid):
    try:
        parts = [int(x) for x in str(objid or "").split(".") if x]
    except ValueError:
        return None
    if len(parts) >= 7 and parts[:6] == [1, 3, 6, 1, 4, 1]:
        return VENDORS.get(parts[6])
    return None


def _scrub(msg, t):
    """A message must never carry a credential, whatever a library chose to echo."""
    for secret in (t.get("community"), t.get("auth_pass"), t.get("priv_pass")):
        if secret and secret in msg:
            msg = msg.replace(secret, "••••")
    return msg


# ---------------- the wire ----------------
def _auth_data(t):
    """pysnmp credentials for one normalised target. Raises SnmpError on a bad combination."""
    if t["version"] == "3":
        if not t["user"]:
            raise SnmpError("auth", "SNMPv3 needs a user name")
        if t["auth_proto"] not in _AUTH:
            raise SnmpError("auth", f"unknown auth protocol {t['auth_proto']!r}")
        if t["priv_proto"] not in _PRIV:
            raise SnmpError("auth", f"unknown privacy protocol {t['priv_proto']!r}")
        has_auth, has_priv = t["auth_proto"] != "none", t["priv_proto"] != "none"
        if has_priv and not has_auth:
            raise SnmpError("auth", "SNMPv3 privacy requires an auth protocol as well (authPriv)")
        return hlapi.UsmUserData(t["user"],
                                 authKey=(t["auth_pass"] or None) if has_auth else None,
                                 privKey=(t["priv_pass"] or None) if has_priv else None,
                                 authProtocol=_AUTH[t["auth_proto"]], privProtocol=_PRIV[t["priv_proto"]])
    if t["version"] != "2c":
        raise SnmpError("error", f"unsupported SNMP version {t['version']!r} (2c or 3)")
    if not t["community"]:
        raise SnmpError("auth", "SNMPv2c needs a community string")
    return hlapi.CommunityData(t["community"], mpModel=1)


class Session:
    """Wire access to ONE configured target. ``get`` and ``walk`` return plain
    Python values and raise ``SnmpError`` with a classified kind."""

    def __init__(self, engine, target, timeout=TIMEOUT_S, retries=RETRIES):
        self.engine, self.t = engine, target
        self.timeout, self.retries = timeout, retries
        self.auth = _auth_data(target)
        self.tgt = None

    async def open(self):
        try:
            self.tgt = await hlapi.UdpTransportTarget.create((self.t["host"], self.t["port"]),
                                                       timeout=self.timeout, retries=self.retries)
        except Exception as e:           # unresolvable name, bad address
            raise SnmpError("error", f"cannot resolve {self.t['host']!r}: {type(e).__name__}: {e}"[:160]) from None
        return self

    def _timeout_msg(self):
        total = self.timeout * (self.retries + 1)
        where = f"{self.t['host']}:{self.t['port']}"
        if self.t["version"] == "2c":
            why = ("host unreachable, SNMP disabled or firewalled, or a wrong community - a v2c agent silently "
                   "drops a request with a bad community, so those look identical from here")
        elif self.t["priv_proto"] != "none":
            why = ("host unreachable, SNMP disabled or firewalled, or a wrong privacy passphrase/protocol - an "
                   "agent silently drops what it cannot decrypt (a wrong AUTH passphrase would have been reported)")
        else:
            why = "host unreachable, or SNMP disabled or firewalled (an auth failure would have been reported as such)"
        return f"no answer from {where} within {total:.0f}s: {why}"

    def _classify(self, ei, es):
        """errorIndication / errorStatus -> SnmpError, or None when the response is fine."""
        user = self.t.get("user") or ""
        if ei is not None:
            if isinstance(ei, errind.RequestTimedOut):
                return SnmpError("timeout", self._timeout_msg())
            if isinstance(ei, errind.EncryptionError) or "Ciphering" in str(ei):
                return SnmpError("library", "SNMPv3 privacy needs the cryptography package on the dashboard "
                                            "host: pip install cryptography")
            if isinstance(ei, errind.WrongDigest):
                return SnmpError("auth", f"authentication failed for v3 user {user!r}: wrong auth passphrase "
                                         f"or wrong auth protocol ({self.t['auth_proto']})")
            if isinstance(ei, errind.UnknownUserName):
                return SnmpError("auth", f"the agent does not know v3 user {user!r}")
            if isinstance(ei, (errind.UnsupportedSecurityLevel, errind.AuthenticationFailure,
                               errind.DecryptionError, errind.NotInTimeWindow, errind.UnknownEngineID,
                               errind.UnsupportedAuthProtocol, errind.UnsupportedPrivProtocol,
                               errind.NoAuthentication, errind.NoEncryption, errind.UnknownSecurityName)):
                return SnmpError("auth", f"{type(ei).__name__}: {ei}")
            return SnmpError("error", f"{type(ei).__name__}: {ei}")
        if es:
            try:
                code = int(es)
            except (TypeError, ValueError):
                code = -1
            if code == 16:
                return SnmpError("auth", "authorizationError: the agent refused the request - for v3 this usually "
                                         "means it requires a higher security level for this user (auth, or "
                                         "authPriv); for v2c the community is read-restricted to a view")
            if code == 2:
                return SnmpError("nosuch", "noSuchName: the agent has no such object")
            label = es.prettyPrint() if hasattr(es, "prettyPrint") else str(es)
            return SnmpError("error", f"SNMP error status {code} ({label})")
        return None

    def _raised(self, e):
        """An exception out of pysnmp (it raises for some conditions instead of returning them)."""
        if isinstance(e, SnmpError):
            return e
        ei = None
        try:
            ei = e["errorIndication"]
        except (KeyError, TypeError, IndexError, AttributeError):
            ei = getattr(e, "errorIndication", None)
        if ei is not None:
            err = self._classify(ei, None)
            if err:
                return err
        return SnmpError("error", f"{type(e).__name__}: {e}"[:160])

    async def get(self, *oids):
        """{oid: value}; an OID the agent does not have maps to None."""
        try:
            ei, es, _ex, vbs = await hlapi.get_cmd(self.engine, self.auth, self.tgt, hlapi.ContextData(),
                                                   *[hlapi.ObjectType(hlapi.ObjectIdentity(o)) for o in oids],
                                                   lookupMib=False)
        except Exception as e:
            raise self._raised(e) from None
        err = self._classify(ei, es)
        if err:
            raise err
        out = dict.fromkeys(oids)
        for name, val in vbs:
            out[str(name)] = _py(val)
        return out

    async def walk(self, base, max_rows=MAX_IFACES):
        """[(index tuple, value)] for one table column; absent values are skipped."""
        base_t = tuple(int(x) for x in base.split("."))
        rows = []
        try:
            async for ei, es, _ex, vbs in hlapi.bulk_walk_cmd(
                    self.engine, self.auth, self.tgt, hlapi.ContextData(), 0, BULK_REPS,
                    hlapi.ObjectType(hlapi.ObjectIdentity(base)),
                    lexicographicMode=False, lookupMib=False, maxRows=max_rows):
                err = self._classify(ei, es)
                if err:
                    raise err
                for name, val in vbs:
                    oid = tuple(name)
                    if oid[:len(base_t)] != base_t:
                        continue
                    v = _py(val)
                    if v is None:
                        continue
                    rows.append((oid[len(base_t):], v))
                if len(rows) >= max_rows:
                    break
        except SnmpError:
            raise
        except Exception as e:
            raise self._raised(e) from None
        return rows[:max_rows]


# ---------------- what is read ----------------
async def _column(sess, oid, key, into, max_rows=MAX_IFACES, index_len=1):
    for suffix, v in await sess.walk(oid, max_rows):
        if len(suffix) != index_len:
            continue
        into.setdefault(suffix if index_len > 1 else suffix[0], {})[key] = v


async def _structure(sess):
    """Interface names, types, speeds, MACs, plus LLDP (or CDP) neighbours. Refreshed every SLOW_S."""
    ifs = {}
    for key, oid in IF_STATIC.items():
        await _column(sess, oid, key, ifs)
    for idx, d in ifs.items():
        d["descr"], d["name"], d["alias"] = _text(d.get("descr")), _text(d.get("name")), _text(d.get("alias"))
        d["mac"] = _mac(d.get("mac"))
        hs, sp = d.get("high_speed"), d.get("speed")
        if hs:
            d["speed_bps"] = int(hs) * 1_000_000
        elif sp and 0 < int(sp) < 4294967295:          # 4294967295 = "faster than 32 bits can say"
            d["speed_bps"] = int(sp)
        else:
            d["speed_bps"] = None
        d["index"] = idx

    chassis = {"id": None, "type": None, "sys_name": None}
    neighbours, nb_err, proto = [], None, None
    try:
        loc = await sess.get(LLDP_LOC_CHASSIS_SUBTYPE, LLDP_LOC_CHASSIS_ID, LLDP_LOC_SYSNAME)
        if loc.get(LLDP_LOC_CHASSIS_ID) is not None:
            cid, ctype = _decode_id(loc.get(LLDP_LOC_CHASSIS_SUBTYPE), loc.get(LLDP_LOC_CHASSIS_ID), CHASSIS_TYPES)
            chassis = {"id": cid, "type": ctype, "sys_name": _text(loc.get(LLDP_LOC_SYSNAME))}
        locports = {}
        for key, oid in LLDP_LOC_PORT.items():
            await _column(sess, oid, key, locports)
        rem = {}
        for key, oid in LLDP_REM.items():
            await _column(sess, oid, key, rem, MAX_NEIGHBOURS, index_len=3)
        man = {}
        for suffix, _v in await sess.walk(LLDP_REM_MAN_ADDR_IFID, MAX_NEIGHBOURS):
            # lldpRemManAddrEntry index: timeMark.localPort.remIndex.addrSubtype.addrLen.addr...
            if len(suffix) >= 9 and suffix[3] == 1 and suffix[4] == 4:
                man.setdefault(suffix[:3], ".".join(str(x) for x in suffix[5:9]))
        for (_tm, lport, _ri), r in rem.items():
            cid, ctype = _decode_id(r.get("chassis_subtype"), r.get("chassis_id"), CHASSIS_TYPES)
            pid, ptype = _decode_id(r.get("port_subtype"), r.get("port_id"), PORT_TYPES)
            neighbours.append({"proto": "lldp", "local_port": lport,
                               "local_ifindex": _lldp_ifindex(lport, locports.get(lport) or {}, ifs),
                               "chassis_id": cid, "chassis_id_type": ctype, "port_id": pid, "port_id_type": ptype,
                               "port_descr": _text(r.get("port_descr")), "sys_name": _text(r.get("sys_name")),
                               "sys_descr": _text(r.get("sys_descr"), 120), "mgmt_ip": man.get((_tm, lport, _ri))})
        if neighbours:
            proto = "lldp"
        else:                                  # Cisco gear that speaks no LLDP: the CDP cache
            cdp = {}
            for key, oid in CDP_CACHE.items():
                await _column(sess, oid, key, cdp, MAX_NEIGHBOURS, index_len=2)
            for (ifindex, _di), r in cdp.items():
                addr = _ipv4(r.get("addr")) if r.get("addr_type") in (None, 1) else None
                neighbours.append({"proto": "cdp", "local_port": ifindex, "local_ifindex": ifindex if ifindex in ifs else None,
                                   "chassis_id": _text(r.get("device_id")), "chassis_id_type": "name",
                                   "port_id": _text(r.get("port")), "port_id_type": "ifname",
                                   "port_descr": None, "sys_name": _text(r.get("device_id")),
                                   "sys_descr": _text(r.get("platform"), 120), "mgmt_ip": addr})
            if neighbours:
                proto = "cdp"
    except SnmpError as e:
        nb_err = f"{e.kind}: {e}"           # the device is fine; its neighbour tables are not readable
    for nb in neighbours:
        p = ifs.get(nb.get("local_ifindex")) or {}
        nb["local_port_name"] = p.get("name") or p.get("descr")
    return {"ifs": ifs, "chassis": chassis, "neighbours": neighbours[:MAX_NEIGHBOURS],
            "nb_proto": proto, "nb_err": nb_err, "ts": time.time()}


def _lldp_ifindex(lport, locport, ifs):
    """lldpLocPortNum -> ifIndex. By the local port id when it names an
    interface, a MAC or a local number; else the port number itself if that is
    a real ifIndex; else None (never a guess)."""
    sub, pid = locport.get("subtype"), locport.get("id")
    if pid is not None:
        if sub == 7 and isinstance(pid, bytes) and pid.strip().isdigit():
            n = int(pid)
            if n in ifs:
                return n
        if sub in (5, 7, 1):
            name = _text(pid)
            for idx, d in ifs.items():
                if name and name in (d.get("name"), d.get("descr")):
                    return idx
        if sub == 3:
            m = _mac(pid)
            for idx, d in ifs.items():
                if m and d.get("mac") == m:
                    return idx
    return lport if lport in ifs else None


async def _live(sess, ifs):
    """Status and counters per interface: HC where the agent has it, else 32-bit."""
    live = {}
    for key, oid in IF_LIVE.items():
        await _column(sess, oid, key, live)
    if not any("hc_in" in d for d in live.values()):
        for key, oid in IF_32.items():
            await _column(sess, oid, key, live)
    return live


def _trust32(speed_bps, dt):
    """A 32-bit counter can only be trusted if the port could not have wrapped
    more than once in the interval. Unknown speed: no bound, no trust."""
    return bool(speed_bps) and dt > 0 and (speed_bps / 8.0) * dt < 2 ** 32


def _ports(host, ifs, live, now, dt):
    out = []
    for idx in sorted(ifs)[:MAX_IFACES]:
        d, c = ifs[idx], live.get(idx) or {}
        hc = c.get("hc_in") is not None and c.get("hc_out") is not None
        if hc:
            rx_c, tx_c = c["hc_in"], c["hc_out"]
        else:
            rx_c, tx_c = c.get("in32"), c.get("out32")
        rx = tx = None
        if rx_c is not None and tx_c is not None and (hc or _trust32(d.get("speed_bps"), dt)):
            k = f"{host}.{idx}.{'hc' if hc else '32'}"
            rx = _rates.rate(k + ".rx", rx_c, now)
            tx = _rates.rate(k + ".tx", tx_c, now)
        out.append({"index": idx, "name": d.get("name") or d.get("descr") or str(idx), "descr": d.get("descr"),
                    "alias": d.get("alias"), "type": d.get("type"), "mac": d.get("mac"),
                    "speed_bps": d.get("speed_bps"),
                    "admin": ADMIN.get(c.get("admin")) if c.get("admin") is not None else None,
                    "oper": OPER.get(c.get("oper")) if c.get("oper") is not None else None,
                    "rx_bps": round(rx * 8.0, 1) if rx is not None else None,
                    "tx_bps": round(tx * 8.0, 1) if tx is not None else None,
                    "measured": rx is not None and tx is not None,
                    "hc": hc if rx_c is not None else None,
                    "rx_err": c.get("in_err"), "tx_err": c.get("out_err")})
    return out


def _public(t):
    """What a target looks like in anything published. No credential field exists here."""
    return {"id": f"snmp:{t['host']}", "host": t["host"], "name": t["name"] or None, "role": t["role"],
            "version": t["version"], "port": t["port"]}


def _down(t, now, kind, msg):
    """A device that did not answer: up=false, the reason, last-known shape flagged stale, every rate absent."""
    last = (_dev.get(t["host"]) or {}).get("last") or {}
    ports = [dict(p, rx_bps=None, tx_bps=None, measured=False, hc=None, rx_err=None, tx_err=None,
                  admin=None, oper=None) for p in (last.get("ports") or [])]
    d = dict(_public(t), name=last.get("name") or t["name"] or t["host"], label=t["name"] or last.get("name") or t["host"],
             up=False, err=_scrub(msg, t), err_kind=kind, ts=now, stale=True,
             descr=last.get("descr"), object_id=last.get("object_id"), vendor=last.get("vendor"), uptime_s=None,
             chassis_id=last.get("chassis_id"), chassis_id_type=last.get("chassis_id_type"),
             macs=last.get("macs") or [], ports=ports, ports_total=len(ports), ports_up=None,
             neighbors=last.get("neighbors") or [], nb_proto=last.get("nb_proto"), latency_ms=None)
    return d


async def _poll_one(engine, t, now, force_struct=False):
    """One device, one tick. Never raises SnmpError: the device record carries the failure."""
    st = _dev.setdefault(t["host"], {"struct": None, "struct_ts": 0.0, "last": None, "last_ts": 0.0})
    try:
        sess = await Session(engine, t).open()
        t0 = time.monotonic()
        sysv = await sess.get(SYS_DESCR, SYS_OBJID, SYS_UPTIME, SYS_NAME)
        latency = round((time.monotonic() - t0) * 1000.0, 1)
        if all(sysv.get(o) is None for o in (SYS_DESCR, SYS_OBJID, SYS_UPTIME, SYS_NAME)):
            raise SnmpError("nosuch", "the agent answered, but has no such object: the MIB-II system group "
                                      f"({SYS_NAME}) is missing - is this really an SNMP agent?")
        if force_struct or st["struct"] is None or now - st["struct_ts"] >= SLOW_S:
            st["struct"] = await _structure(sess)
            st["struct_ts"] = now
        struct = st["struct"]
        live = await _live(sess, struct["ifs"])
    except SnmpError as e:
        return _down(t, now, e.kind, str(e))
    dt = now - st["last_ts"] if st["last_ts"] else 0.0
    ports = _ports(t["host"], struct["ifs"], live, now, dt)
    st["last_ts"] = now
    ch = struct["chassis"]
    macs = sorted({p["mac"] for p in ports if p.get("mac")} | ({ch["id"]} if ch.get("type") == "mac" and ch.get("id") else set()))
    sysname = _text(sysv.get(SYS_NAME)) or ch.get("sys_name")
    uptime = sysv.get(SYS_UPTIME)
    dev = dict(_public(t), name=sysname or t["name"] or t["host"], label=t["name"] or sysname or t["host"],
               up=True, err=struct.get("nb_err"), err_kind=None, ts=now, stale=False,
               descr=_text(sysv.get(SYS_DESCR), 160), object_id=sysv.get(SYS_OBJID),
               vendor=_vendor(sysv.get(SYS_OBJID)),
               uptime_s=int(uptime) // 100 if isinstance(uptime, int) else None,
               chassis_id=ch.get("id"), chassis_id_type=ch.get("type"), macs=macs,
               ports=ports, ports_total=len(ports), ports_up=sum(1 for p in ports if p.get("oper") == "up"),
               neighbors=struct["neighbours"], nb_proto=struct.get("nb_proto"), latency_ms=latency)
    st["last"] = dev
    return dev


async def _tick(engine, now, targets):
    coros = [asyncio.wait_for(_poll_one(engine, t, now), TARGET_BUDGET_S) for t in targets]
    results = await asyncio.gather(*coros, return_exceptions=True)
    devices = []
    for t, r in zip(targets, results, strict=True):
        if isinstance(r, dict):
            devices.append(r)
        elif isinstance(r, asyncio.TimeoutError | TimeoutError):
            devices.append(_down(t, now, "timeout", f"{t['host']} did not finish within the {TARGET_BUDGET_S}s budget"))
        else:
            devices.append(_down(t, now, "error", f"{type(r).__name__}: {r}"[:160]))
    up = sum(1 for d in devices if d.get("up"))
    first_err = next((f"{d['label']}: {d['err']}" for d in devices if not d.get("up")), None)
    DATA["snmp"] = {"up": up > 0, "ts": now, "targets": len(targets), "devices_up": up,
                    "devices": devices, "err": first_err, "lib": None}
    return devices


async def _engine():
    return hlapi.SnmpEngine()    # created on the loop it will run on


def poll_snmp():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    engine = loop.run_until_complete(_engine())
    targets = config.SNMP_TARGETS[:MAX_TARGETS]
    while True:
        try:
            loop.run_until_complete(_tick(engine, time.time(), targets))
            if len(_rates.prev) > 16384:      # bounded state; a clear just skips one interval
                _rates.clear()
        except Exception as e:
            print("[snmp]", f"{type(e).__name__}: {e}"[:200], flush=True)
        time.sleep(POLL_S)


def start_snmp(data=None):
    """Launch the SNMP poller as a daemon thread (mirror of start_probe)."""
    global DATA
    if data is not None:
        DATA = data
    n = len(config.SNMP_TARGETS)
    if not n:
        DATA["snmp"] = {"up": False, "err": "not configured", "devices": [], "targets": 0, "devices_up": 0,
                        "ts": 0, "lib": None}
        return False
    if LIB_ERR:
        print(f"[snmp] {n} target(s) configured but {LIB_ERR}", flush=True)
        DATA["snmp"] = {"up": False, "err": LIB_ERR, "devices": [], "targets": n, "devices_up": 0,
                        "ts": 0, "lib": LIB_ERR}
        return False
    if n > MAX_TARGETS:
        print(f"[snmp] {n} targets configured; polling the first {MAX_TARGETS}", flush=True)
    DATA["snmp"] = {"up": False, "err": "not polled yet", "devices": [], "targets": min(n, MAX_TARGETS),
                    "devices_up": 0, "ts": 0, "lib": None}
    threading.Thread(target=poll_snmp, daemon=True, name="snmp").start()
    return True


# ---------------- the setup wizard's Test button ----------------
def _close(loop, engine):
    try:
        engine.close_dispatcher()
    except Exception:
        pass
    try:
        pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
        for t in pending:
            t.cancel()
        if pending:
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
    except Exception:
        pass
    loop.close()


def test_target(row, budget_s=20.0):
    """Validate one target as the wizard sees it. Returns a detail string or
    raises RuntimeError whose message names WHICH of timeout / auth / no such
    object happened. Never mentions a credential."""
    if LIB_ERR:
        raise RuntimeError(LIB_ERR)
    t = config.snmp_target(row)
    if not t["host"]:
        raise RuntimeError("no address given")
    loop = asyncio.new_event_loop()
    try:
        asyncio.set_event_loop(loop)
        engine = loop.run_until_complete(_engine())
        try:
            # private per-call state: the live poller's device cache and its
            # counter samples for this host are set aside and put back, so a
            # Test click neither reads stale structure nor leaves a sample
            # behind that would make the poller's next tick look measured
            saved = _dev.pop(t["host"], None)
            prefix = t["host"] + "."
            saved_prev = {k: _rates.prev.pop(k) for k in list(_rates.prev) if k.startswith(prefix)}
            saved_ema = {k: _rates.ema.pop(k) for k in list(_rates.ema) if k.startswith(prefix)}
            try:
                dev = loop.run_until_complete(asyncio.wait_for(_poll_one(engine, t, time.time(), force_struct=True),
                                                               budget_s))
            except (asyncio.TimeoutError, TimeoutError):
                raise RuntimeError(f"timeout: {t['host']} did not finish within {budget_s:.0f}s") from None
            finally:
                _dev.pop(t["host"], None)
                for k in [k for k in _rates.prev if k.startswith(prefix)]:
                    _rates.prev.pop(k, None); _rates.ema.pop(k, None)
                _rates.prev.update(saved_prev); _rates.ema.update(saved_ema)
                if saved is not None:
                    _dev[t["host"]] = saved
        finally:
            _close(loop, engine)
    finally:
        asyncio.set_event_loop(None)
    if not dev.get("up"):
        kind = {"timeout": "timeout", "auth": "authentication", "nosuch": "no such object",
                "library": "library missing"}.get(dev.get("err_kind"), "error")
        raise RuntimeError(f"{kind}: {dev.get('err')}")
    up = dev.get("uptime_s")
    upt = f"{up // 86400}d {(up % 86400) // 3600}h" if isinstance(up, int) else "?"
    nbs = dev.get("neighbors") or []
    what = dev.get("vendor") or (dev.get("descr") or "")[:40] or "SNMP agent"
    nb = f"{len(nbs)} {dev.get('nb_proto') or 'LLDP/CDP'} neighbours" if nbs else "no LLDP/CDP neighbours"
    if dev.get("err"):
        nb += f" ({dev['err']})"
    return (f"{dev['name']} ({t['host']}): {what} · up {upt} · {dev['ports_total']} interfaces, "
            f"{dev['ports_up']} up · {nb} · {dev['latency_ms']} ms")
