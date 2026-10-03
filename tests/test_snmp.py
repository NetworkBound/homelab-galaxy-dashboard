"""snmp.py: honest counters, classified failures, LLDP merge, and no credential anywhere public.

The wire is faked (``FakeSession``) so every rule here is checked without
pysnmp installed; the last class drives a real net-snmp agent on loopback
when both pysnmp and ``snmpd`` are available, and skips otherwise.
"""
import importlib
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import types
import unittest

from _helpers import clean_env, clear_modules

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# Obvious non-secrets, in the shapes the real fields take.
COMMUNITY = "example-community-ro-0001"
AUTH_PASS = "example-auth-passphrase-0001"
PRIV_PASS = "example-priv-passphrase-0001"

IF, IFX = "1.3.6.1.2.1.2.2.1.", "1.3.6.1.2.1.31.1.1.1."
LLDP = "1.0.8802.1.1.2.1."


class FakeSession:
    """Answers from dicts; raises whatever ``fail`` says. Same surface as snmp.Session."""

    def __init__(self, engine, target):
        self.t = target
        spec = FAKES[target["host"]]
        self.get_map, self.tables, self.fail = spec.get("get", {}), spec.get("tables", {}), spec.get("fail")

    async def open(self):
        return self

    async def get(self, *oids):
        if self.fail:
            raise self.fail
        return {o: self.get_map.get(o) for o in oids}

    async def walk(self, base, max_rows=512):
        if self.fail:
            raise self.fail
        rows = sorted(self.tables.get(base, {}).items())
        return rows[:max_rows]


FAKES = {}


def sysgroup(name="sw", descr="Example switch", objid="1.3.6.1.4.1.9.1.1208", uptime=123456):
    return {"1.3.6.1.2.1.1.1.0": descr.encode(), "1.3.6.1.2.1.1.2.0": objid,
            "1.3.6.1.2.1.1.3.0": uptime, "1.3.6.1.2.1.1.5.0": name.encode()}


def iface_tables(ports, hc=True, speed=1_000_000_000):
    """ports: {ifindex: (name, mac_bytes, oper, in_octets, out_octets)}."""
    t = {IF + "2": {}, IF + "3": {}, IF + "5": {}, IF + "6": {}, IFX + "1": {}, IFX + "15": {}, IFX + "18": {},
         IF + "7": {}, IF + "8": {}, IF + "14": {}, IF + "20": {}, IFX + "6": {}, IFX + "10": {},
         IF + "10": {}, IF + "16": {}}
    for idx, (name, mac, oper, i, o) in ports.items():
        k = (idx,)
        t[IF + "2"][k] = name.encode(); t[IF + "3"][k] = 6; t[IF + "5"][k] = min(speed, 4294967295)
        t[IF + "6"][k] = mac; t[IFX + "1"][k] = name.encode(); t[IFX + "15"][k] = speed // 1_000_000
        t[IF + "7"][k] = 1; t[IF + "8"][k] = oper; t[IF + "14"][k] = 0; t[IF + "20"][k] = 0
        if hc:
            t[IFX + "6"][k] = i; t[IFX + "10"][k] = o
        t[IF + "10"][k] = i % 2 ** 32; t[IF + "16"][k] = o % 2 ** 32
    return t


def lldp_tables(chassis_mac, neighbours):
    """neighbours: [(local_port, remote_chassis_mac_bytes_or_None, port_id_bytes, sys_name, mgmt_ip_or_None)]."""
    t = {LLDP + "3.7.1.2": {}, LLDP + "3.7.1.3": {}, LLDP + "3.7.1.4": {}}
    for col in ("4", "5", "6", "7", "8", "9", "10"):
        t[LLDP + "4.1.1." + col] = {}
    t[LLDP + "4.2.1.4"] = {}
    get = {LLDP + "3.1.0": 4, LLDP + "3.2.0": chassis_mac, LLDP + "3.3.0": b"sw"}
    for n, (lport, rmac, pid, sname, mgmt) in enumerate(neighbours, start=1):
        t[LLDP + "3.7.1.2"][(lport,)] = 7; t[LLDP + "3.7.1.3"][(lport,)] = str(lport).encode()
        k = (0, lport, n)
        t[LLDP + "4.1.1.4"][k] = 4 if rmac else 7
        t[LLDP + "4.1.1.5"][k] = rmac or sname.encode()
        t[LLDP + "4.1.1.6"][k] = 3 if len(pid) == 6 and not pid.isalnum() else 5
        t[LLDP + "4.1.1.7"][k] = pid; t[LLDP + "4.1.1.8"][k] = b"port"
        t[LLDP + "4.1.1.9"][k] = sname.encode(); t[LLDP + "4.1.1.10"][k] = b"descr"
        if mgmt:
            t[LLDP + "4.2.1.4"][(0, lport, n, 1, 4, *(int(x) for x in mgmt.split(".")))] = 1
    return get, t


def mac(s):
    return bytes.fromhex(s.replace(":", ""))


class SnmpBase(unittest.TestCase):
    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        os.environ["CONFIG_FILE"] = os.path.join(self.td.name, "config.json")
        os.environ["DATA_DIR"] = self.td.name
        FAKES.clear()

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()

    def load(self):
        snmp = importlib.import_module("snmp")
        snmp.Session = FakeSession          # the wire, replaced
        snmp._dev.clear()
        snmp._rates.clear()
        return snmp

    @staticmethod
    def target(host, **kw):
        base = {"host": host, "name": "", "version": "2c", "community": COMMUNITY, "port": 161, "user": "",
                "auth_proto": "none", "auth_pass": "", "priv_proto": "none", "priv_pass": "", "role": "switch"}
        base.update(kw)
        return base

    @staticmethod
    def poll(snmp, t, now):
        import asyncio
        return asyncio.run(snmp._poll_one(None, t, now))


class CounterTest(SnmpBase):
    def test_counter_wrap_gives_no_reading_never_a_spike(self):
        """32-bit counter rolls over between samples -> that interval has no rate; the next one does."""
        snmp = self.load()
        t = self.target("10.0.0.2")
        p = {1: ("Gi1/0/1", mac("02:00:00:00:00:01"), 1, 4_294_000_000, 10_000)}
        FAKES["10.0.0.2"] = {"get": sysgroup(), "tables": iface_tables(p, hc=False)}
        d1 = self.poll(snmp, t, 1000.0)
        port = d1["ports"][0]
        self.assertFalse(port["measured"]); self.assertIsNone(port["rx_bps"]); self.assertFalse(port["hc"])
        p[1] = ("Gi1/0/1", mac("02:00:00:00:00:01"), 1, 1_000_000, 20_000)         # wrapped
        FAKES["10.0.0.2"]["tables"] = iface_tables(p, hc=False)
        d2 = self.poll(snmp, t, 1010.0)
        port = d2["ports"][0]
        self.assertFalse(port["measured"], "a wrapped counter must produce no reading")
        self.assertIsNone(port["rx_bps"]); self.assertIsNone(port["tx_bps"])
        p[1] = ("Gi1/0/1", mac("02:00:00:00:00:01"), 1, 2_000_000, 30_000)
        FAKES["10.0.0.2"]["tables"] = iface_tables(p, hc=False)
        d3 = self.poll(snmp, t, 1020.0)
        port = d3["ports"][0]
        self.assertTrue(port["measured"])
        self.assertAlmostEqual(port["rx_bps"], 1_000_000 * 8 / 10.0, delta=1)
        self.assertAlmostEqual(port["tx_bps"], 10_000 * 8 / 10.0, delta=1)
        self.assertTrue(d3["up"]); self.assertEqual(d3["name"], "sw"); self.assertEqual(d3["vendor"], "Cisco")

    def test_counter_reset_gives_no_reading(self):
        """A device reboot resets HC counters: the interval is skipped, no negative or huge rate."""
        snmp = self.load()
        t = self.target("10.0.0.3")
        m = mac("02:00:00:00:00:02")
        series = [(1_000_000_000, 500), (2_000_000_000, 900), (500_000_000, 100), (600_000_000, 200)]
        rates = []
        for i, (rx, tx) in enumerate(series):
            FAKES["10.0.0.3"] = {"get": sysgroup(uptime=10 if i == 2 else 999999),
                                 "tables": iface_tables({1: ("eth0", m, 1, rx, tx)})}
            rates.append(self.poll(snmp, t, 2000.0 + 10 * i)["ports"][0])
        self.assertFalse(rates[0]["measured"])                       # first sample
        self.assertTrue(rates[1]["measured"]); self.assertAlmostEqual(rates[1]["rx_bps"], 1e9 * 8 / 10, delta=1)
        self.assertFalse(rates[2]["measured"], "a reset must produce no reading")
        self.assertIsNone(rates[2]["rx_bps"])
        self.assertTrue(rates[3]["measured"]); self.assertAlmostEqual(rates[3]["rx_bps"], 1e8 * 8 / 10, delta=1)
        self.assertTrue(rates[3]["hc"])

    def test_hc_counters_preferred_over_32bit(self):
        """When the agent has both, the 64-bit column is what is differenced."""
        snmp = self.load()
        t = self.target("10.0.0.4")
        m = mac("02:00:00:00:00:03")
        FAKES["10.0.0.4"] = {"get": sysgroup(), "tables": iface_tables({1: ("eth0", m, 1, 2 ** 32 - 100, 0)})}
        self.poll(snmp, t, 3000.0)
        FAKES["10.0.0.4"] = {"get": sysgroup(), "tables": iface_tables({1: ("eth0", m, 1, 2 ** 32 + 900, 0)})}
        port = self.poll(snmp, t, 3010.0)["ports"][0]      # 32-bit view wrapped; HC did not
        self.assertTrue(port["hc"]); self.assertTrue(port["measured"])
        self.assertAlmostEqual(port["rx_bps"], 1000 * 8 / 10.0, delta=1)

    def test_32bit_counter_untrusted_when_the_port_could_wrap_within_the_interval(self):
        """A 10G port with only 32-bit counters can wrap more than once in 30 s: no reading, by rule."""
        snmp = self.load()
        t = self.target("10.0.0.5")
        m = mac("02:00:00:00:00:04")
        FAKES["10.0.0.5"] = {"get": sysgroup(), "tables": iface_tables({1: ("x", m, 1, 100, 100)}, hc=False, speed=10_000_000_000)}
        self.poll(snmp, t, 4000.0)
        FAKES["10.0.0.5"] = {"get": sysgroup(), "tables": iface_tables({1: ("x", m, 1, 200, 200)}, hc=False, speed=10_000_000_000)}
        port = self.poll(snmp, t, 4030.0)["ports"][0]
        self.assertFalse(port["measured"]); self.assertIsNone(port["rx_bps"])
        self.assertTrue(snmp._trust32(1_000_000_000, 10.0))
        self.assertFalse(snmp._trust32(10_000_000_000, 30.0))
        self.assertFalse(snmp._trust32(None, 10.0), "unknown speed: no bound, no trust")


class FailureTest(SnmpBase):
    def test_target_that_times_out_is_down_not_present_with_zero(self):
        snmp = self.load()
        t = self.target("10.0.0.6", name="edge-sw")
        FAKES["10.0.0.6"] = {"fail": snmp.SnmpError("timeout", "no answer from 10.0.0.6:161 within 4s")}
        d = self.poll(snmp, t, 5000.0)
        self.assertFalse(d["up"]); self.assertEqual(d["err_kind"], "timeout"); self.assertIn("no answer", d["err"])
        self.assertEqual(d["ports"], []); self.assertEqual(d["label"], "edge-sw"); self.assertIsNone(d["uptime_s"])
        self.assertTrue(d["stale"])
        # a device that answered before keeps its shape, flagged stale, with every rate absent
        m = mac("02:00:00:00:00:05")
        FAKES["10.0.0.6"] = {"get": sysgroup(name="edge"), "tables": iface_tables({1: ("eth0", m, 1, 10, 10), 2: ("eth1", m, 2, 0, 0)})}
        self.poll(snmp, t, 5010.0)
        up = self.poll(snmp, t, 5020.0)
        self.assertTrue(up["up"]); self.assertTrue(up["ports"][0]["measured"]); self.assertEqual(up["ports"][0]["rx_bps"], 0.0)
        FAKES["10.0.0.6"] = {"fail": snmp.SnmpError("timeout", "no answer")}
        down = self.poll(snmp, t, 5030.0)
        self.assertFalse(down["up"]); self.assertTrue(down["stale"]); self.assertEqual(down["name"], "edge")
        self.assertEqual(len(down["ports"]), 2)
        for p in down["ports"]:
            self.assertFalse(p["measured"]); self.assertIsNone(p["rx_bps"]); self.assertIsNone(p["oper"])
        # the whole tick: a dict per target, never an exception out of the poller
        import asyncio
        FAKES["10.0.0.7"] = {"fail": RuntimeError("unexpected")}
        devs = asyncio.run(snmp._tick(None, 5040.0, [t, self.target("10.0.0.7")]))
        self.assertEqual([d["up"] for d in devs], [False, False])
        self.assertEqual(devs[1]["err_kind"], "error")
        self.assertFalse(snmp.DATA["snmp"]["up"]); self.assertEqual(snmp.DATA["snmp"]["targets"], 2)

    def test_v3_auth_failure_is_classified_not_a_timeout(self):
        """What the wire returns for each v3 failure, mapped to a kind the wizard can name."""
        snmp = importlib.import_module("snmp")        # the real Session class; no wire is touched here
        snmp._rates.clear()
        names = ("RequestTimedOut", "EncryptionError", "WrongDigest", "UnknownUserName", "UnsupportedSecurityLevel",
                 "AuthenticationFailure", "DecryptionError", "NotInTimeWindow", "UnknownEngineID",
                 "UnsupportedAuthProtocol", "UnsupportedPrivProtocol", "NoAuthentication", "NoEncryption",
                 "UnknownSecurityName")
        fake = types.SimpleNamespace(**{n: type(n, (Exception,), {}) for n in names})
        snmp.errind = fake
        s = snmp.Session.__new__(snmp.Session)
        s.timeout, s.retries = 2.0, 1
        s.t = self.target("10.0.0.8", version="3", user="dash", auth_proto="sha", auth_pass=AUTH_PASS,
                          priv_proto="aes", priv_pass=PRIV_PASS)
        e = s._classify(fake.WrongDigest("Wrong SNMP PDU digest"), None)
        self.assertEqual(e.kind, "auth"); self.assertIn("auth passphrase", str(e)); self.assertIn("dash", str(e))
        self.assertEqual(s._classify(fake.UnknownUserName("x"), None).kind, "auth")
        self.assertEqual(s._classify(fake.UnsupportedSecurityLevel("x"), None).kind, "auth")
        lib = s._classify(fake.EncryptionError("Ciphering services not available"), None)
        self.assertEqual(lib.kind, "library"); self.assertIn("cryptography", str(lib))
        self.assertEqual(s._classify(None, 16).kind, "auth")                 # authorizationError
        to = s._classify(fake.RequestTimedOut("x"), None)
        self.assertEqual(to.kind, "timeout"); self.assertIn("privacy passphrase", str(to))
        s.t = self.target("10.0.0.8", version="3", user="dash", auth_proto="sha", auth_pass=AUTH_PASS)
        self.assertNotIn("privacy", str(s._classify(fake.RequestTimedOut("x"), None)))
        s.t = self.target("10.0.0.8")
        v2 = s._classify(fake.RequestTimedOut("x"), None)
        self.assertEqual(v2.kind, "timeout"); self.assertIn("wrong community", str(v2))
        for msg in (str(e), str(to), str(v2), str(lib)):
            for secret in (COMMUNITY, AUTH_PASS, PRIV_PASS):
                self.assertNotIn(secret, msg)
        # a library that echoed a credential back is scrubbed before anything is published
        d = snmp._down(self.target("10.0.0.9"), 1.0, "error", f"agent said {COMMUNITY} is wrong")
        self.assertNotIn(COMMUNITY, d["err"]); self.assertIn("••••", d["err"])

    def test_library_missing_degrades_to_a_message(self):
        os.environ.update({"SNMP_0_HOST": "10.0.0.2", "SNMP_0_COMMUNITY": COMMUNITY})
        snmp = importlib.import_module("snmp")
        snmp.LIB_ERR = "pysnmp 7.x is not installed (ModuleNotFoundError): pip install 'pysnmp>=7.1,<8'"
        before = {th.name for th in threading.enumerate()}
        data = {}
        self.assertFalse(snmp.start_snmp(data))
        self.assertFalse(data["snmp"]["up"]); self.assertIn("pip install", data["snmp"]["err"])
        self.assertEqual(data["snmp"]["targets"], 1); self.assertEqual(data["snmp"]["devices"], [])
        self.assertEqual({th.name for th in threading.enumerate()} - before, set())
        snmp.LIB_ERR = None
        config = importlib.import_module("config")
        problems = [p for p in config.missing_required() if "SNMP" in p]
        self.assertEqual(problems, [], "a v2c target with a community is complete")
        os.environ.pop("SNMP_0_COMMUNITY")
        clear_modules()
        config = importlib.import_module("config")
        self.assertTrue(any("SNMP_0_COMMUNITY" in p for p in config.missing_required()))


class MergeTest(SnmpBase):
    CORE = "02:62:33:3d:04:92"
    GW = "02:65:80:ed:cc:93"

    def devices(self):
        """Topology-shaped UniFi devices: a gateway and a switch."""
        return [{"mac": self.GW, "type": "udm", "name": "Gateway", "model": "UDMPROSE", "ip": "10.0.8.2", "state": 1,
                 "uplink": {}, "port_table": []},
                {"mac": self.CORE, "type": "usw", "name": "Core Switch", "model": "USPM24", "ip": "10.0.0.201",
                 "state": 1, "uplink": {"uplink_mac": self.GW, "speed": 10000}, "port_table": []}]

    @staticmethod
    def snmp_dev(host, chassis, name, neighbours, up=True):
        ports = [{"index": i, "name": f"Gi1/0/{i}", "descr": f"GigabitEthernet1/0/{i}", "alias": None, "type": 6,
                  "mac": f"02:5c:1a:00:{host.split('.')[-1].zfill(2)[-2:]}:{i:02x}", "speed_bps": 1_000_000_000,
                  "admin": "up", "oper": "up", "rx_bps": 1000.0 * i, "tx_bps": 2000.0 * i, "measured": True,
                  "hc": True, "rx_err": 0, "tx_err": 0} for i in range(1, 9)]
        return {"id": f"snmp:{host}", "host": host, "name": name, "label": name, "role": "switch", "version": "2c",
                "port": 161, "up": up, "err": None, "err_kind": None, "ts": 1.0, "stale": False, "descr": "IOS",
                "object_id": "1.3.6.1.4.1.9.1.1", "vendor": "Cisco", "uptime_s": 10, "chassis_id": chassis,
                "chassis_id_type": "mac", "macs": [chassis] + [p["mac"] for p in ports], "ports": ports,
                "ports_total": 8, "ports_up": 8, "nb_proto": "lldp", "latency_ms": 1.0,
                "neighbors": [{"proto": "lldp", "local_port": lp, "local_ifindex": lp, "local_port_name": f"Gi1/0/{lp}",
                               "chassis_id": cid, "chassis_id_type": ct, "port_id": "x", "port_id_type": "local",
                               "port_descr": None, "sys_name": sn, "sys_descr": None, "mgmt_ip": ip}
                              for lp, cid, ct, sn, ip in neighbours]}

    def test_lldp_merge_does_not_duplicate_a_known_device(self):
        topology = importlib.import_module("topology")
        NAS = "02:5c:1a:00:aa:10"
        devs = [
            # the UniFi core switch, ALSO polled over SNMP: same chassis MAC -> one node
            self.snmp_dev("10.0.0.201", self.CORE, "Core Switch", [(1, self.GW, "mac", "Gateway", "10.0.8.2")]),
            # a Cisco behind it, uplinked by LLDP to the core; a NAS and a Proxmox host on its ports
            self.snmp_dev("10.0.0.150", "02:5c:1a:00:02:02", "lab-sw-1",
                          [(1, self.CORE, "mac", "Core Switch", "10.0.0.201"), (5, NAS, "mac", "backup-nas", "10.0.0.170"),
                           (3, "02:5c:1a:00:ff:01", "mac", "pve1", "10.0.0.38")]),
            # same name as the core, DIFFERENT chassis and address: a different box, so a node of its own
            self.snmp_dev("10.0.0.151", "02:5c:1a:00:02:09", "Core Switch", [(1, "02:5c:1a:00:02:02", "mac", "lab-sw-1", "10.0.0.150")]),
            # the Cisco listed twice under a second address: merged by chassis, not drawn twice
            self.snmp_dev("10.0.0.152", "02:5c:1a:00:02:02", "lab-sw-1", []),
        ]
        plan = topology._snmp_plan(devs, {self.CORE: f"unifi:{self.CORE}", self.GW: f"unifi:{self.GW}"},
                                   {"10.0.0.201": f"unifi:{self.CORE}", "10.0.8.2": f"unifi:{self.GW}", "10.0.0.38": "pve:pve1"},
                                   f"unifi:{self.GW}")
        by = {it["dev"]["host"]: it for it in plan["devices"]}
        self.assertEqual(by["10.0.0.201"]["merge_into"], f"unifi:{self.CORE}")
        self.assertEqual(by["10.0.0.150"]["nid"], "snmp:10.0.0.150")
        self.assertEqual(by["10.0.0.150"]["parent"], f"unifi:{self.CORE}")
        self.assertEqual(by["10.0.0.150"]["uplink"]["local_ifindex"], 1)
        self.assertEqual(by["10.0.0.151"]["nid"], "snmp:10.0.0.151", "a display name is not a merge key")
        self.assertEqual(by["10.0.0.151"]["parent"], "snmp:10.0.0.150")
        self.assertEqual(by["10.0.0.152"]["merge_into"], "snmp:10.0.0.150", "one chassis, two addresses: one node")
        nids = [it["nid"] for it in plan["devices"] if not it["merge_into"]]
        self.assertEqual(len(nids), len(set(nids)))
        self.assertEqual(plan["attach"]["10.0.0.38"][0], "snmp:10.0.0.150")
        self.assertEqual(plan["attach"][NAS][0], "snmp:10.0.0.150")
        self.assertNotIn(self.CORE, plan["attach"])            # infrastructure is never "attached"
        # parents come before children in placement order
        order = [it["nid"] for it in plan["devices"]]
        self.assertLess(order.index("snmp:10.0.0.150"), order.index("snmp:10.0.0.151"))

        # ---- the full build: one node per physical box, LLDP attachments, neighbour nodes ----
        topology.DATA = {"snmp": {"up": True, "devices": devs}, "probe": {"rtt": {}, "arp": {}, "unknown": []}}
        topology.PVE_NODES = lambda: [{"node": "pve1", "url": "https://10.0.0.38:8006", "token": "x"}]
        topology._pve_ips = lambda: {"10.0.0.38": "pve1"}
        topology._struct = topology._rebuild(self.devices(), [], [])
        topo = topology._build(self.devices(), [], {}, [], 100.0, True, True, False)
        ids = [n["id"] for n in topo["nodes"]]
        self.assertEqual(len(ids), len(set(ids)), "a node id appeared twice")
        self.assertNotIn("snmp:10.0.0.201", ids); self.assertNotIn("snmp:10.0.0.152", ids)
        by_id = {n["id"]: n for n in topo["nodes"]}
        core = by_id[f"unifi:{self.CORE}"]
        self.assertTrue(core["meta"].get("snmp")); self.assertEqual(core["meta"]["ports_total"], 8)
        self.assertEqual(core["kind"], "switch"); self.assertEqual(core["parent"], f"unifi:{self.GW}")
        lab = by_id["snmp:10.0.0.150"]
        self.assertEqual(lab["parent"], f"unifi:{self.CORE}"); self.assertEqual(lab["kind"], "switch")
        self.assertTrue(lab["measured"]); self.assertEqual(lab["meta"]["uplink_port"], "Gi1/0/1")
        self.assertEqual(lab["rx"], 1000.0 / 8); self.assertEqual(lab["meta"]["mac"], "02:5c:1a:00:02:02")
        lk = next(x for x in topo["links"] if x["target"] == "snmp:10.0.0.150")
        self.assertEqual(lk["source"], f"unifi:{self.CORE}"); self.assertTrue(lk["measured"]); self.assertEqual(lk["capacity_bps"], 1_000_000_000)
        pve = by_id["pve:pve1"]
        self.assertEqual(pve["parent"], "snmp:10.0.0.150"); self.assertEqual(pve["meta"]["port"], "Gi1/0/3"); self.assertTrue(pve["meta"]["lldp"])
        self.assertEqual(pve["rx"], 2000.0 * 3 / 8); self.assertTrue(pve["measured"])
        nas = by_id[f"lldp:{NAS}"]
        self.assertEqual(nas["parent"], "snmp:10.0.0.150"); self.assertEqual(nas["ip"], "10.0.0.170")
        self.assertTrue(nas["meta"]["lldp"]); self.assertEqual(nas["meta"]["port"], "Gi1/0/5"); self.assertEqual(nas["label"], "backup-nas")
        self.assertNotIn("lldp:02:5c:1a:00:ff:01", ids, "the Proxmox host was matched by address, not drawn again")
        nbs = {n["sys_name"]: n["node"] for n in lab["meta"]["neighbors"]}
        self.assertEqual(nbs, {"Core Switch": f"unifi:{self.CORE}", "backup-nas": f"lldp:{NAS}", "pve1": "pve:pve1"})
        self.assertEqual(topo["totals"]["snmp_devices"], 4); self.assertEqual(topo["totals"]["snmp_up"], 4)
        self.assertEqual(by_id["snmp:10.0.0.151"]["label"], "Core Switch")

    def test_a_down_device_is_a_down_node_with_nothing_measured(self):
        topology = importlib.import_module("topology")
        d = self.snmp_dev("10.0.0.160", "02:5c:1a:00:02:30", "dead-sw", [], up=False)
        d.update(stale=True, err="no answer", err_kind="timeout")
        for p in d["ports"]:
            p.update(rx_bps=None, tx_bps=None, measured=False, oper=None)
        topology.DATA = {"snmp": {"up": False, "devices": [d]}, "probe": {}}
        topology.PVE_NODES = lambda: []
        topology._pve_ips = lambda: {}
        topology._struct = topology._rebuild(self.devices(), [], [])
        topo = topology._build(self.devices(), [], {}, [], 100.0, True, True, False)
        n = next(x for x in topo["nodes"] if x["id"] == "snmp:10.0.0.160")
        self.assertEqual(n["status"], "down"); self.assertFalse(n["measured"]); self.assertEqual(n["rx"], 0.0)
        self.assertEqual(n["parent"], f"unifi:{self.GW}", "no LLDP evidence: the gateway is all we know")
        self.assertTrue(n["meta"]["stale"]); self.assertEqual(n["meta"]["snmp_err"], "no answer")
        self.assertEqual(topo["totals"]["snmp_up"], 0)

    def test_demo_fixture_is_what_the_planner_would_produce(self):
        topology = importlib.import_module("topology")
        with open(os.path.join(REPO, "demo", "fixtures", "snmp.json")) as fh:
            snmp_doc = json.load(fh)
        with open(os.path.join(REPO, "demo", "fixtures", "topology.json")) as fh:
            topo = json.load(fh)
        by_id = {n["id"]: n for n in topo["nodes"]}
        unifi = {n["id"].split(":", 1)[1]: n["id"] for n in topo["nodes"] if n["id"].startswith("unifi:")}
        gw = next(n["id"] for n in topo["nodes"] if n["kind"] == "gateway")
        plan = topology._snmp_plan(snmp_doc["devices"], unifi, {n["ip"]: n["id"] for n in topo["nodes"] if n["id"].startswith("unifi:")}, gw)
        self.assertEqual(len(plan["devices"]), 2)
        for it in plan["devices"]:
            n = by_id[it["nid"]]
            self.assertEqual(n["parent"], it["parent"]); self.assertEqual(n["kind"], "switch"); self.assertTrue(n["meta"]["snmp"])
            self.assertTrue(any(lk["source"] == it["parent"] and lk["target"] == it["nid"] for lk in topo["links"]))
        self.assertEqual(plan["devices"][0]["parent"], unifi[self.CORE], "the Cisco uplinks into the UniFi core, not a duplicate of it")
        self.assertEqual(plan["devices"][1]["parent"], plan["devices"][0]["nid"])
        for snid, nb in plan["pending"]:
            n = by_id[f"lldp:{nb['chassis_id']}"]
            self.assertEqual(n["parent"], snid); self.assertTrue(n["meta"]["lldp"]); self.assertEqual(n["ip"], nb["mgmt_ip"])
        self.assertEqual(topo["totals"]["snmp_devices"], 2)


class CredentialTest(unittest.TestCase):
    TOKEN = "example-setup-token-123456"

    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        os.environ.update({"CONFIG_FILE": os.path.join(self.td.name, "config.json"), "DATA_DIR": self.td.name,
                           "SETUP_TOKEN": self.TOKEN, "ENABLE_GPU": "false",
                           "SNMP_0_HOST": "10.0.0.2", "SNMP_0_COMMUNITY": COMMUNITY,
                           "SNMP_1_HOST": "10.0.0.3", "SNMP_1_VERSION": "3", "SNMP_1_USER": "dashboard",
                           "SNMP_1_AUTH_PROTO": "sha256", "SNMP_1_AUTH_PASS": AUTH_PASS,
                           "SNMP_1_PRIV_PROTO": "aes", "SNMP_1_PRIV_PASS": PRIV_PASS})
        self.app = importlib.import_module("app")
        self.client = self.app.app.test_client()

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()

    def test_no_snmp_credential_of_any_kind_is_public(self):
        secrets = (COMMUNITY, AUTH_PASS, PRIV_PASS)
        cfg = self.client.get("/api/config")
        self.assertEqual(cfg.status_code, 200)
        body = cfg.get_data(as_text=True)
        self.assertTrue(cfg.get_json()["features"]["snmp"])
        for s in secrets:
            self.assertNotIn(s, body)
        self.assertNotIn("community", body.lower())
        h = {"X-Setup-Token": self.TOKEN}
        for path in ("/api/setup/schema", "/api/setup/config"):
            r = self.client.get(path, headers=h)
            self.assertEqual(r.status_code, 200, path)
            text = json.dumps(r.get_json(), ensure_ascii=False)      # jsonify escapes the mask as \u2022
            for s in secrets:
                self.assertNotIn(s, text, path)
            self.assertIn("••••", text, path)
        # what the poller publishes carries no credential field at all, even on failure
        snmp = importlib.import_module("snmp")
        config = importlib.import_module("config")
        self.assertEqual(len(config.SNMP_TARGETS), 2)
        snmp.DATA = self.app.DATA
        devs = [snmp._down(t, 1.0, "timeout", f"no answer; tried {t['community'] or t['auth_pass']}") for t in config.SNMP_TARGETS]
        self.app.DATA["snmp"] = {"up": False, "ts": 1.0, "targets": 2, "devices_up": 0, "devices": devs, "err": devs[0]["err"], "lib": None}
        allj = self.client.get("/api/all").get_data(as_text=True)
        for s in secrets:
            self.assertNotIn(s, allj)
        for d in devs:
            for k in ("community", "auth_pass", "priv_pass", "user"):
                self.assertNotIn(k, d)
        self.assertIn("••••", devs[0]["err"])
        # the wizard's test path reports a kind, never the credential (library absent here is itself a clean answer)
        r = self.client.post("/api/setup/test", headers=h, json={"section": "snmp", "values": [
            {"host": "10.0.0.2", "version": "2c", "community": COMMUNITY}]})
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(COMMUNITY, r.get_data(as_text=True))


def _free_udp_port():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _have_pysnmp():
    try:
        import pysnmp.hlapi.v3arch.asyncio  # noqa: F401
        return True
    except Exception:
        return False


@unittest.skipUnless(_have_pysnmp() and shutil.which("snmpd"), "needs pysnmp 7 and net-snmp's snmpd")
class LiveAgentTest(unittest.TestCase):
    """A real net-snmp agent on loopback: real timeouts, real v3 digests, real counters.
    Only shapes are asserted; nothing the agent reports about this host is written anywhere."""

    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.TemporaryDirectory()
        cls.port = _free_udp_port()
        conf = os.path.join(cls.td.name, "snmpd.conf")
        with open(conf, "w") as fh:
            fh.write(f"rocommunity {COMMUNITY} 127.0.0.1\n"
                     f'createUser example-v3auth SHA "{AUTH_PASS}"\nrouser example-v3auth auth\n'
                     f'createUser example-v3priv SHA "{AUTH_PASS}" AES "{PRIV_PASS}"\nrouser example-v3priv priv\n'
                     "sysName lab-agent.example.com\nsysDescr loopback test agent\n")
        os.makedirs(os.path.join(cls.td.name, "persist"))
        env = dict(os.environ, SNMP_PERSISTENT_DIR=os.path.join(cls.td.name, "persist"))
        cls.proc = subprocess.Popen(["snmpd", "-f", "-C", "-c", conf, "-Lf", os.path.join(cls.td.name, "snmpd.log"),
                                     "--noPersistentLoad=1", "--noPersistentSave=1", f"udp:127.0.0.1:{cls.port}"],
                                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        cls.td.cleanup()

    def setUp(self):
        clean_env()
        clear_modules()
        self.cfgdir = tempfile.TemporaryDirectory()
        os.environ["CONFIG_FILE"] = os.path.join(self.cfgdir.name, "config.json")
        os.environ["DATA_DIR"] = self.cfgdir.name
        self.snmp = importlib.import_module("snmp")
        self.snmp.TIMEOUT_S, self.snmp.RETRIES = 1.0, 0
        self.assertIsNone(self.snmp.LIB_ERR)

    def tearDown(self):
        clean_env()
        clear_modules()
        self.cfgdir.cleanup()

    def row(self, **kw):
        base = {"host": "127.0.0.1", "port": self.port, "version": "2c", "community": COMMUNITY}
        base.update(kw)
        return base

    def test_v2c_poll_and_measured_rates(self):
        detail = self.snmp.test_target(self.row())
        self.assertIn("lab-agent.example.com", detail); self.assertIn("interfaces", detail)
        import asyncio
        t = importlib.import_module("config").snmp_target(self.row())
        loop = asyncio.new_event_loop()
        try:
            asyncio.set_event_loop(loop)
            eng = loop.run_until_complete(self.snmp._engine())
            d1 = loop.run_until_complete(self.snmp._poll_one(eng, t, time.time()))
            self.assertTrue(d1["up"]); self.assertGreater(d1["ports_total"], 0); self.assertEqual(d1["vendor"], "net-snmp")
            self.assertTrue(all(p["measured"] is False for p in d1["ports"]), "first sample: nothing measured")
            time.sleep(1.1)
            d2 = loop.run_until_complete(self.snmp._poll_one(eng, t, time.time()))
            hc = [p for p in d2["ports"] if p["hc"]]
            self.assertTrue(hc, "net-snmp exposes HC counters")
            self.assertTrue(all(p["measured"] for p in hc))
            self.assertTrue(all(p["rx_bps"] is not None and p["rx_bps"] >= 0 for p in hc))
            self.assertEqual(d2["neighbors"], [])            # no LLDP on a host agent: absent, not invented
            self.snmp._close(loop, eng)
        finally:
            asyncio.set_event_loop(None)

    def test_wrong_community_and_dead_port_are_timeouts_that_say_so(self):
        with self.assertRaises(RuntimeError) as cm:
            self.snmp.test_target(self.row(community="example-wrong-community"))
        self.assertTrue(str(cm.exception).startswith("timeout:")); self.assertIn("wrong community", str(cm.exception))
        self.assertNotIn("example-wrong-community", str(cm.exception))
        with self.assertRaises(RuntimeError) as cm:
            self.snmp.test_target(self.row(port=_free_udp_port()))
        self.assertTrue(str(cm.exception).startswith("timeout:"))

    def test_v3_auth_and_failures(self):
        ok = self.snmp.test_target(self.row(version="3", user="example-v3auth", auth_proto="sha", auth_pass=AUTH_PASS))
        self.assertIn("lab-agent.example.com", ok)
        with self.assertRaises(RuntimeError) as cm:
            self.snmp.test_target(self.row(version="3", user="example-v3auth", auth_proto="sha", auth_pass="example-wrong-pass-1"))
        self.assertTrue(str(cm.exception).startswith("authentication:"), str(cm.exception))
        self.assertNotIn("example-wrong-pass-1", str(cm.exception))
        with self.assertRaises(RuntimeError) as cm:
            self.snmp.test_target(self.row(version="3", user="nobody-here", auth_proto="sha", auth_pass=AUTH_PASS))
        self.assertTrue(str(cm.exception).startswith("authentication:"))
        with self.assertRaises(RuntimeError) as cm:     # auth-only against a user the agent requires privacy from
            self.snmp.test_target(self.row(version="3", user="example-v3priv", auth_proto="sha", auth_pass=AUTH_PASS))
        self.assertTrue(str(cm.exception).startswith("authentication:"), str(cm.exception))
        try:
            import cryptography  # noqa: F401
            have_crypto = True
        except Exception:
            have_crypto = False
        r = self.row(version="3", user="example-v3priv", auth_proto="sha", auth_pass=AUTH_PASS, priv_proto="aes", priv_pass=PRIV_PASS)
        if have_crypto:
            self.assertIn("lab-agent.example.com", self.snmp.test_target(r))
            with self.assertRaises(RuntimeError) as cm:
                self.snmp.test_target(dict(r, priv_pass="example-wrong-priv-1"))
            self.assertTrue(str(cm.exception).startswith("timeout:")); self.assertIn("privacy", str(cm.exception))
        else:
            with self.assertRaises(RuntimeError) as cm:
                self.snmp.test_target(r)
            self.assertTrue(str(cm.exception).startswith("library missing:"))

    def test_wizard_test_route(self):
        os.environ.update({"SETUP_TOKEN": "example-setup-token-123456", "ENABLE_GPU": "false"})
        clear_modules()
        app = importlib.import_module("app")
        c = app.app.test_client()
        r = c.post("/api/setup/test", headers={"X-Setup-Token": "example-setup-token-123456"},
                   json={"section": "snmp", "values": [self.row()]}).get_json()
        self.assertTrue(r["ok"], r); self.assertIn("SNMP ·", r["detail"])
        r = c.post("/api/setup/test", headers={"X-Setup-Token": "example-setup-token-123456"},
                   json={"section": "snmp", "values": [self.row(community="example-wrong")]}).get_json()
        self.assertFalse(r["ok"]); self.assertIn("timeout", r["error"]); self.assertNotIn("example-wrong", r["error"])


if __name__ == "__main__":
    unittest.main()
