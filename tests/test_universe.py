#!/usr/bin/env python3
"""Tests for universe.py + static/universe_layout.js. stdlib unittest only.

    python3 tests/test_universe.py -v

JS parity tests run through `node` when it is on PATH and are skipped otherwise.
"""
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import config  # noqa: E402

# The registry is generic; these tests describe one estate: two Proxmox nodes (pve2
# then pve1, the order the slot tests expect), a camera site and a branch site.
config.UNIVERSE_SITES = [{"id": "remote", "label": "remote site", "cidr": "10.0.2.0/24", "accent": "#fc8181"},
                         {"id": "branch", "label": "branch site", "cidr": "10.0.3.0/24", "accent": "#63b3ed"}]
config.UNIVERSE_CAMERA_SITE = "remote"
config.UNIVERSE_LAB_GROUPS, config.UNIVERSE_LAB_HOSTS, config.UNIVERSE_LAB_VMIDS = ["Lab/Bench network"], [], []
config.UNIVERSE_NAME_PREFIXES = ["Pve2", "Acme"]
config.PVE_NODES = []
import universe as U  # noqa: E402

U._node_hint[:] = ["pve2", "pve1"]
U.LAB_GROUPS[:] = config.UNIVERSE_LAB_GROUPS

LAYOUT_JS = os.path.join(ROOT, "static", "universe_layout.js")
NODE = shutil.which("node")
T0 = 1_790_000_000.0
DAY = 86400


# ---- Python port of universe_layout.js (geometry + place) -------------------------
A1, A2, TAU = 0.7548776662466927, 0.5698402909980532, math.pi * 2
CORE_R, SPACING, MIN_W, GAP, JITTER, EDGE_R = 1.2, 0.55, 0.5, 0.45, 0.18, 60.0


def frac(v):
    return v - math.floor(v)


def py_geometry(caps):
    keys = sorted(int(k) for k, v in caps.items() if v > 0)
    out, r = {}, CORE_R
    for i, k in enumerate(keys):
        n = caps[str(k)] if str(k) in caps else caps[k]
        r0 = r if i == 0 else r + GAP
        w = max(MIN_W, math.sqrt(r0 * r0 + n * SPACING * SPACING / math.pi) - r0)
        out[k] = (r0, r0 + w)
        r = r0 + w
    return out


def py_place(body, geom):
    seed, n, shell = body["seed"] & 0xFFFFFFFF, body["slot"], body["shell"]
    j1 = ((seed & 0xFFFF) / 65535) - 0.5
    j2 = (((seed >> 16) & 0xFFFF) / 65535) - 0.5
    g = geom.get(shell)
    if body["system"] is None:
        r0, r1 = EDGE_R, EDGE_R + ((g[1] - g[0]) if g else MIN_W)
    elif not g:
        r0, r1 = CORE_R, CORE_R + MIN_W
    else:
        r0, r1 = g
    if body["system"] is not None and shell == 0 and n == 0:
        return 0.0, 0.0
    rot = TAU * (U.hash32(f"{body['system'] if body['system'] is not None else 'null'}#{shell}") / 4294967296)
    theta = frac(0.5 + n * A1) * TAU + rot
    u = frac(0.5 + n * A2)
    r = math.sqrt(r0 * r0 + u * (r1 * r1 - r0 * r0))
    r += j1 * JITTER * SPACING
    theta += (j2 * JITTER * SPACING) / max(r, 0.5)
    theta = frac(theta / TAU) * TAU
    return r, theta


def run_node(script):
    p = subprocess.run([NODE, "-e", script], capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        raise AssertionError(p.stderr)
    return json.loads(p.stdout)


# ---- fixtures ------------------------------------------------------------------
def topo_fixture(extra_clients=(), guests=(("pve2", 101, "pihole", "lxc"),)):
    nodes = [
        {"id": "wan", "kind": "wan", "label": "ISP", "ip": "10.0.9.1", "parent": None,
         "rx": 10.0, "tx": 5.0, "measured": True, "status": "up", "meta": {}},
        {"id": "unifi:aa:00:00:00:00:01", "kind": "gateway", "label": "UDM", "ip": "10.0.9.2",
         "parent": "wan", "rx": 1, "tx": 1, "measured": True, "status": "up", "meta": {}},
        {"id": "unifi:aa:00:00:00:00:02", "kind": "switch", "label": "USW", "ip": "10.0.0.201",
         "parent": "unifi:aa:00:00:00:00:01", "rx": 1, "tx": 1, "measured": True,
         "status": "up", "meta": {}},
        {"id": "pve:pve2", "kind": "pvehost", "label": "pve2", "ip": "10.0.0.238",
         "parent": "unifi:aa:00:00:00:00:02", "rx": 0, "tx": 0, "measured": True,
         "status": "up", "meta": {}},
        {"id": "ext:nvr-10.0.2.100", "kind": "external", "label": "NVR", "ip": "10.0.2.100",
         "parent": "unifi:aa:00:00:00:00:01", "rx": 0, "tx": 0, "measured": False,
         "status": "unknown", "meta": {}},
    ]
    for node, vmid, name, typ in guests:
        nodes.append({"id": f"guest:{node}:{vmid}", "kind": "guest", "label": name,
                      "ip": None, "parent": f"pve:{node}", "rx": 1.0, "tx": 1.0,
                      "measured": True, "status": "up",
                      "meta": {"cat": "network", "type": typ, "vmid": vmid, "cpu": 3.0}})
    for mac, ip, label, cat in extra_clients:
        nodes.append({"id": f"client:{mac}", "kind": "client", "label": label, "ip": ip,
                      "parent": "unifi:aa:00:00:00:00:02", "rx": 2.0, "tx": 2.0,
                      "measured": True, "status": "up",
                      "meta": {"cat": cat, "mac": mac, "wired": False}})
    links = [{"source": n["parent"], "target": n["id"], "bps": 8.0, "measured": True}
             for n in nodes if n.get("parent")]
    return {"ts": T0, "nodes": nodes, "links": links, "flows": []}


def all_fixture(netmap=(), unknown=(), cameras=()):
    return {"netmap": {"devices": [{"ip": ip, "name": nm, "group": grp, "up": up}
                                   for ip, nm, grp, up in netmap]},
            "probe": {"unknown": list(unknown), "rtt": {}},
            "cameras": list(cameras),
            "frigate": {"up": True, "cams": [{"name": c, "fps": 5.0} for c in cameras]},
            "edge": {"cloudflare": {"up": True, "req_per_min": 3.0}}}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="universe-test-")
        self.path = os.path.join(self.dir, "slots.json")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def build(self, topo, alld, now, store=None, fresh=True, **kw):
        store = store or U.Store(self.path)
        obs = U.observe(topo, alld, now=now, **kw)
        return U.build(obs, store, now=now, fresh=fresh, topo=topo), store

    @staticmethod
    def by_id(res):
        return {b["id"]: b for b in res["bodies"]}


# ---- identity / merge ------------------------------------------------------------
class TestIdentity(Base):
    def test_identity_merge_across_feeds(self):
        """Same device via UniFi (mac+ip), LibreNMS (ip) and the ICMP sweep (ip) = one body."""
        topo = topo_fixture(extra_clients=[("bb:00:00:00:00:10", "10.0.0.120", "hp", "printer")])
        alld = all_fixture(netmap=[("10.0.0.120", "hp-printer", "network", 1)],
                           unknown=["10.0.0.120"])
        res, _ = self.build(topo, alld, T0)
        hits = [b for b in res["bodies"] if b.get("m", {}).get("ip") == "10.0.0.120"]
        self.assertEqual(len(hits), 1, hits)
        b = hits[0]
        self.assertEqual(b["id"], "mac:bb:00:00:00:00:10")
        self.assertEqual(b["class"], "printer")
        self.assertEqual(sorted(b["src"]), ["probe", "snmp", "unifi"])

    def test_station_with_guest_mac_merges_into_guest(self):
        topo = topo_fixture()
        stas = [{"mac": "bc:24:11:00:00:65", "ip": "10.0.0.65", "is_wired": True,
                 "sw_mac": "aa:00:00:00:00:02", "sw_port": 16}]
        res, _ = self.build(topo, all_fixture(), T0, stas=stas,
                            gmac={("pve2", 101): "bc:24:11:00:00:65"})
        guests = [b for b in res["bodies"] if b["class"] == "guest_lxc"]
        self.assertEqual(len(guests), 1)
        self.assertEqual(guests[0]["id"], "vm:pve2:101")         # guests: vm always
        self.assertIn("unifi", guests[0]["src"])
        self.assertIn("proxmox", guests[0]["src"])
        self.assertFalse(any(b["id"] == "ip:10.0.0.65" for b in res["bodies"]))

    def test_full_station_list_adds_missing_clients(self):
        topo = topo_fixture()
        stas = [{"mac": "cc:00:00:00:00:01", "ip": "10.0.0.50", "is_wired": False,
                 "ap_mac": "aa:00:00:00:00:02", "hostname": "iPhone", "rx_bytes-r": 10}]
        res, _ = self.build(topo, all_fixture(), T0, stas=stas)
        b = self.by_id(res)["mac:cc:00:00:00:00:01"]
        self.assertEqual(b["src"], ["unifi"])
        self.assertEqual(b["parent"], "mac:aa:00:00:00:00:02")
        self.assertIn("tx_bps", b["m"])            # rx_bytes-r measured
        self.assertNotIn("rx_bps", b["m"])         # tx_bytes-r absent -> not invented

    def test_guest_mac_appearing_later_keeps_vm_id(self):
        topo = topo_fixture()
        res1, store = self.build(topo, all_fixture(), T0)                 # cold start: no MACs
        b1 = self.by_id(res1)["vm:pve2:101"]
        stas = [{"mac": "bc:24:11:00:00:65", "ip": "10.0.0.65", "is_wired": True}]
        res2, _ = self.build(topo, all_fixture(), T0 + 60, store=store, stas=stas,
                             gmac={("pve2", 101): "bc:24:11:00:00:65"})
        ids = self.by_id(res2)
        self.assertNotIn("mac:bc:24:11:00:00:65", ids)
        self.assertEqual((ids["vm:pve2:101"]["shell"], ids["vm:pve2:101"]["slot"]),
                         (b1["shell"], b1["slot"]))
        # NIC recreated with a new MAC: still the same body
        res3, _ = self.build(topo, all_fixture(), T0 + 120, store=store,
                             gmac={("pve2", 101): "bc:24:11:00:00:99"})
        self.assertEqual(len([b for b in res3["bodies"] if b["class"] == "guest_lxc"]), 1)
        self.assertEqual(store.data["alias"]["mac:bc:24:11:00:00:65"], "vm:pve2:101")
        self.assertEqual(store.data["alias"]["mac:bc:24:11:00:00:99"], "vm:pve2:101")

    def test_known_offline_duplicate_mac_of_live_named_device_is_skipped(self):
        topo = topo_fixture(extra_clients=[("fc:00:00:00:00:01", "10.0.0.30", "P1 Pro-8CE9", "3dprinter")])
        known = [{"mac": "22:00:00:00:00:01", "hostname": "P1 Pro-8CE9", "last_seen": T0 - 3600},
                 {"mac": "22:00:00:00:00:02", "hostname": "iPhone", "last_seen": T0 - 3600},
                 {"mac": "22:00:00:00:00:03", "hostname": "Meghan", "last_seen": T0 - 40 * DAY}]
        res, _ = self.build(topo, all_fixture(), T0, known=known)
        ids = self.by_id(res)
        self.assertNotIn("mac:22:00:00:00:00:01", ids)          # second MAC of a live device
        self.assertEqual(ids["mac:22:00:00:00:00:02"]["status"], "down")   # generic name: kept
        self.assertNotIn("mac:22:00:00:00:00:03", ids)          # older than 30 days

    def test_every_netmap_and_probe_entry_is_represented_or_excluded(self):
        """Regression (udm-pro-se-Acme at 10.0.0.1 looked dropped): every
        LibreNMS device and every probe.unknown address maps to a body, either as
        its ip or as a gateway LAN alias, or is listed in `excluded` with a reason."""
        alld = all_fixture(netmap=[("10.0.0.1", "udm-pro-se-Acme", "network", 1),
                                   ("127.0.0.1", "librenms", "container", 1),
                                   ("10.0.100.1", "starlink", "network", 1),
                                   ("10.0.0.201", "usw", "network", 1),
                                   ("10.0.3.1", "udm-pro-se-Branch", "network", 1)],
                           unknown=["10.0.0.1", "10.0.2.10", "10.0.0.201"])
        excluded = []
        topo = topo_fixture()
        obs = U.observe(topo, alld, gw_lan=("10.0.0.1", "10.0.100.1"), now=T0, excluded=excluded)
        res = U.build(obs, U.Store(self.path), now=T0, topo=topo, excluded=excluded)
        self.assert_all_represented(res, alld)
        gw = self.by_id(res)["mac:aa:00:00:00:00:01"]
        self.assertIn("10.0.0.1", gw["m"]["lan_ips"])
        self.assertEqual(gw["m"]["snmp_name"], "udm-pro-se-Acme")
        self.assertIn("snmp", gw["src"])
        self.assertIn("probe", gw["src"])
        self.assertEqual([e["key"] for e in res["excluded"]], ["127.0.0.1"])

    def assert_all_represented(self, res, alld):
        have = set()
        for b in res["bodies"]:
            m = b.get("m") or {}
            if m.get("ip"):
                have.add(m["ip"])
            have.update(m.get("lan_ips") or [])
            if b["id"].startswith("ip:"):
                have.add(b["id"][3:])
        excl = {e["key"] for e in res.get("excluded") or []}
        for d in alld["netmap"]["devices"]:
            self.assertTrue(d["ip"] in have or d["ip"] in excl, f"netmap {d} dropped")
        for ip in alld["probe"]["unknown"]:
            self.assertTrue(ip in have or ip in excl, f"probe {ip} dropped")

    def test_netmap_device_on_gateway_subnet_address(self):
        alld = all_fixture(netmap=[("10.0.100.1", "starlink", "network", 1),
                                   ("10.0.0.1", "udm-pro-se", "network", 1)])
        res, _ = self.build(topo_fixture(), alld, T0, gw_lan=("10.0.0.1", "10.0.100.1"))
        ids = self.by_id(res)
        self.assertEqual(ids["ip:10.0.100.1"]["class"], "network_device")
        self.assertNotIn("ip:10.0.0.1", ids)
        self.assertIn("snmp", ids["mac:aa:00:00:00:00:01"]["src"])

    def test_ip_only_body_keeps_id_when_mac_appears(self):
        """Cold start: probe sees only an IP; later UniFi reports the MAC. One body, same slot."""
        topo = topo_fixture()
        res1, store = self.build(topo, all_fixture(unknown=["10.0.0.77"]), T0)
        self.assertIn("ip:10.0.0.77", self.by_id(res1))
        topo2 = topo_fixture(extra_clients=[("dd:00:00:00:00:77", "10.0.0.77", "thing", "unknown")])
        res2, _ = self.build(topo2, all_fixture(), T0 + 60, store=store)
        ids = self.by_id(res2)
        self.assertIn("ip:10.0.0.77", ids)
        self.assertNotIn("mac:dd:00:00:00:00:77", ids)
        self.assertEqual(ids["ip:10.0.0.77"]["slot"], self.by_id(res1)["ip:10.0.0.77"]["slot"])

    def test_ip_reused_by_different_mac_is_a_different_device(self):
        topo = topo_fixture(extra_clients=[("ee:00:00:00:00:01", "10.0.0.88", "a", "phone")])
        _, store = self.build(topo, all_fixture(), T0)
        topo2 = topo_fixture(extra_clients=[("ee:00:00:00:00:02", "10.0.0.88", "b", "phone")])
        res2, _ = self.build(topo2, all_fixture(), T0 + 60, store=store)
        ids = self.by_id(res2)
        self.assertEqual(ids["mac:ee:00:00:00:00:01"]["status"], "down")
        self.assertEqual(ids["mac:ee:00:00:00:00:02"]["status"], "up")
        self.assertNotEqual(ids["mac:ee:00:00:00:00:01"]["slot"], ids["mac:ee:00:00:00:00:02"]["slot"])
        self.assertEqual(ids["mac:ee:00:00:00:00:02"]["m"]["ip"], "10.0.0.88")

    def test_dhcp_reuse_after_ip_then_mac(self):
        """ip-only body upgraded by MAC A; the IP later goes to MAC B -> B is a new body."""
        _, store = self.build(topo_fixture(), all_fixture(unknown=["10.0.0.90"]), T0)
        t2 = topo_fixture(extra_clients=[("ee:00:00:00:00:0a", "10.0.0.90", "a", "phone")])
        self.build(t2, all_fixture(), T0 + 60, store=store)
        t3 = topo_fixture(extra_clients=[("ee:00:00:00:00:0b", "10.0.0.90", "b", "phone")])
        res, _ = self.build(t3, all_fixture(), T0 + 120, store=store)
        ids = self.by_id(res)
        self.assertEqual(ids["ip:10.0.0.90"]["status"], "down")        # device A keeps its slot
        self.assertEqual(ids["mac:ee:00:00:00:00:0b"]["status"], "up")


# ---- slots -----------------------------------------------------------------------
class TestSlots(Base):
    def test_slot_stability_when_devices_added(self):
        c = [(f"f0:00:00:00:00:{i:02x}", f"10.0.0.{10 + i}", f"phone{i}", "phone") for i in range(8)]
        res1, store = self.build(topo_fixture(extra_clients=c), all_fixture(), T0)
        before = {b["id"]: (b["system"], b["shell"], b["slot"]) for b in res1["bodies"]}
        more = c[:3] + [(f"f1:00:00:00:00:{i:02x}", f"10.0.0.{100 + i}", f"new{i}", "phone")
                        for i in range(20)] + c[3:]          # inserted in the middle on purpose
        res2, _ = self.build(topo_fixture(extra_clients=more,
                                          guests=(("pve2", 101, "pihole", "lxc"),
                                                  ("pve2", 99, "aaa-first", "lxc"))),
                             all_fixture(cameras=["patio"]), T0 + 600, store=store)
        after = {b["id"]: (b["system"], b["shell"], b["slot"]) for b in res2["bodies"]}
        for bid, pos in before.items():
            self.assertEqual(after[bid], pos, bid)
        phones = sorted(v[2] for k, v in after.items() if k.startswith("mac:f"))
        self.assertEqual(phones, list(range(28)))     # dense, no duplicates
        self.assertTrue(self.by_id(res2)["mac:f1:00:00:00:00:00"]["new"])
        self.assertFalse(self.by_id(res2)["mac:f0:00:00:00:00:00"]["new"])

    def test_slot_survives_restart(self):
        c = [("f0:00:00:00:00:01", "10.0.0.11", "p", "phone")]
        res1, _ = self.build(topo_fixture(extra_clients=c), all_fixture(), T0)
        res2, _ = self.build(topo_fixture(extra_clients=c), all_fixture(), T0 + 600,
                             store=U.Store(self.path))      # fresh process, same file
        strip = lambda r: {b["id"]: (b["system"], b["shell"], b["slot"], b["first_seen"]) for b in r["bodies"]}
        self.assertEqual(strip(res1), strip(res2))

    def test_offline_device_keeps_slot_as_down(self):
        c = [("f0:00:00:00:00:01", "10.0.0.11", "p1", "phone"),
             ("f0:00:00:00:00:02", "10.0.0.12", "p2", "phone")]
        res1, store = self.build(topo_fixture(extra_clients=c), all_fixture(), T0)
        slot = self.by_id(res1)["mac:f0:00:00:00:00:01"]["slot"]
        res2, _ = self.build(topo_fixture(extra_clients=c[1:]), all_fixture(), T0 + 29 * DAY, store=store)
        b = self.by_id(res2)["mac:f0:00:00:00:00:01"]
        self.assertEqual(b["status"], "down")
        self.assertEqual(b["slot"], slot)
        self.assertEqual(b["m"], {})                    # nothing measured -> nothing reported
        # a newcomer during retention must not take the slot
        res3, _ = self.build(topo_fixture(extra_clients=c[1:] + [("f0:00:00:00:00:03", "10.0.0.13", "p3", "phone")]),
                             all_fixture(), T0 + 29 * DAY + 60, store=store)
        self.assertNotEqual(self.by_id(res3)["mac:f0:00:00:00:00:03"]["slot"], slot)

    def test_stale_feeds_report_unknown_not_down(self):
        c = [("f0:00:00:00:00:01", "10.0.0.11", "p1", "phone")]
        _, store = self.build(topo_fixture(extra_clients=c), all_fixture(), T0)
        res2, _ = self.build(topo_fixture(), all_fixture(), T0 + 60, store=store, fresh=False)
        self.assertEqual(self.by_id(res2)["mac:f0:00:00:00:00:01"]["status"], "unknown")

    def test_recycle_only_after_30_days(self):
        c = [("f0:00:00:00:00:01", "10.0.0.11", "p1", "phone"),
             ("f0:00:00:00:00:02", "10.0.0.12", "p2", "phone")]
        res1, store = self.build(topo_fixture(extra_clients=c), all_fixture(), T0)
        slot = self.by_id(res1)["mac:f0:00:00:00:00:01"]["slot"]
        newc = ("f0:00:00:00:00:09", "10.0.0.19", "p9", "phone")
        res2, _ = self.build(topo_fixture(extra_clients=c[1:]), all_fixture(), T0 + 30 * DAY - 120, store=store)
        self.assertIn("mac:f0:00:00:00:00:01", self.by_id(res2))
        res3, _ = self.build(topo_fixture(extra_clients=c[1:] + [newc]), all_fixture(),
                             T0 + 30 * DAY + 120, store=store)
        ids = self.by_id(res3)
        self.assertNotIn("mac:f0:00:00:00:00:01", ids)               # expired
        self.assertEqual(ids["mac:f0:00:00:00:00:09"]["slot"], slot)  # slot recycled
        self.assertEqual(ids["mac:f0:00:00:00:00:02"]["slot"],
                         self.by_id(res1)["mac:f0:00:00:00:00:02"]["slot"])

    def test_baseline_is_not_new(self):
        res, _ = self.build(topo_fixture(), all_fixture(), T0)
        self.assertEqual(res["counts"]["new"], 0)

    def test_new_flag_expires_after_10_minutes(self):
        _, store = self.build(topo_fixture(), all_fixture(), T0)
        c = [("f0:00:00:00:00:01", "10.0.0.11", "p1", "phone")]
        res, _ = self.build(topo_fixture(extra_clients=c), all_fixture(), T0 + 1000, store=store)
        self.assertTrue(self.by_id(res)["mac:f0:00:00:00:00:01"]["new"])
        res, _ = self.build(topo_fixture(extra_clients=c), all_fixture(), T0 + 1000 + 601, store=store)
        self.assertFalse(self.by_id(res)["mac:f0:00:00:00:00:01"]["new"])


# ---- schema / honesty -----------------------------------------------------------------
class TestSchema(Base):
    def test_every_parent_resolves(self):
        c = [("f0:00:00:00:00:01", "10.0.0.11", "p1", "phone")]
        stas = [{"mac": "cc:00:00:00:00:01", "ip": "10.0.0.50", "ap_mac": "aa:00:00:00:00:99"}]
        res, _ = self.build(topo_fixture(extra_clients=c),
                            all_fixture(netmap=[("10.0.100.1", "starlink", "network", 1)],
                                        unknown=["10.0.2.10"], cameras=["patio", "driveway"]),
                            T0, stas=stas)
        self.assert_parents_resolve(res, topo_fixture(extra_clients=c))

    def test_snapshot_parents_resolve(self):
        p = os.path.join(ROOT, "stage_api", "universe.json")
        if not os.path.exists(p):
            self.skipTest("no stage_api/universe.json snapshot")
        with open(p) as f:
            res = json.load(f)
        self.assert_parents_resolve(res, None)

    def assert_parents_resolve(self, res, topo):
        bodies = {b["id"]: b for b in res["bodies"]}
        topo_ids = {n["id"] for n in (topo or {}).get("nodes", [])} if topo else None
        for b in res["bodies"]:
            p = b["parent"]
            if p is None:
                continue
            if p in bodies:
                # a hub (detected/inferred/declared switch) may have no topology node
                self.assertTrue("topo" in bodies[p] or bodies[p].get("hub"), f"{b['id']} -> {p} has no topo")
            else:
                if topo_ids is not None:
                    self.assertIn(p, topo_ids, f"{b['id']} parent {p} unresolvable")
                else:
                    self.assertRegex(p, r"^(unifi|pve|guest|client|disc|snmp|ext):|^wan$")
        for s in res["systems"]:
            self.assertIn("anchor", s, s["id"])

    def test_schema_fields_and_classes(self):
        res, _ = self.build(topo_fixture(extra_clients=[("f0:00:00:00:00:01", "10.0.0.11", "p1", "phone")]),
                            all_fixture(cameras=["patio"]), T0)
        for k in ("v", "ts", "counts", "systems", "bodies", "links"):
            self.assertIn(k, res)
        for b in res["bodies"]:
            for k in ("id", "label", "class", "cat", "system", "parent", "shell", "slot", "seed",
                      "status", "first_seen", "last_seen", "new", "m", "src"):
                self.assertIn(k, b)
            self.assertIn(b["class"], U.CLASSES)
            self.assertIn(b["status"], ("up", "down", "idle", "unknown"))
            self.assertEqual(b["seed"], U.hash32(b["id"]))
            self.assertRegex(b["id"], r"^(mac|vm|snmp|ip|name):")
            if b["class"] == "edge":
                self.assertIsNone(b["system"])
        self.assertEqual(res["counts"]["total"], len(res["bodies"]))
        self.assertEqual(sum(res["counts"]["by_class"].values()), len(res["bodies"]))

    def test_unmeasured_values_absent_not_zero(self):
        topo = topo_fixture(extra_clients=[("f0:00:00:00:00:01", "10.0.0.11", "p1", "phone")])
        for n in topo["nodes"]:
            if n["id"] == "client:f0:00:00:00:00:01":
                n["measured"] = False
                n["rx"] = n["tx"] = 0.0
        res, _ = self.build(topo, all_fixture(), T0)
        m = self.by_id(res)["mac:f0:00:00:00:00:01"]["m"]
        self.assertNotIn("rx_bps", m)
        self.assertNotIn("tx_bps", m)
        self.assertNotIn("rtt_ms", m)


# ---- persistence --------------------------------------------------------------------
class TestPersistence(Base):
    def test_atomic_write_survives_crash_mid_write(self):
        c = [("f0:00:00:00:00:01", "10.0.0.11", "p1", "phone")]
        _, store = self.build(topo_fixture(extra_clients=c), all_fixture(), T0)
        with open(self.path, "rb") as f:
            good = f.read()
        c2 = c + [("f0:00:00:00:00:02", "10.0.0.12", "p2", "phone")]
        real_dump = json.dump

        def dying_dump(obj, fp, **kw):          # write half the file, then "lose power"
            s = json.dumps(obj, **kw)
            fp.write(s[: len(s) // 2])
            fp.flush()
            raise OSError("simulated crash mid-write")

        with mock.patch.object(U.json, "dump", side_effect=dying_dump):
            self.build(topo_fixture(extra_clients=c2), all_fixture(), T0 + 60, store=store)
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(), good)                 # old file intact
        self.assertEqual([n for n in os.listdir(self.dir) if n.endswith(".tmp")], [])
        json.loads(good)

        with mock.patch.object(U.os, "replace", side_effect=OSError("crash before rename")):
            self.build(topo_fixture(extra_clients=c2), all_fixture(), T0 + 120, store=U.Store(self.path))
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(), good)

        # a leftover temp from a real kill -9 is ignored, and the next save succeeds
        with open(os.path.join(self.dir, ".universe.zzz.tmp"), "w") as f:
            f.write('{"half":')
        res, _ = self.build(topo_fixture(extra_clients=c2), all_fixture(), T0 + 180, store=U.Store(self.path))
        with open(self.path) as f:
            d = json.load(f)
        self.assertIn("mac:f0:00:00:00:00:02", d["bodies"])
        self.assertIs(json.dump, real_dump)

    def test_corrupt_store_is_moved_aside(self):
        with open(self.path, "w") as f:
            f.write("{not json")
        res, _ = self.build(topo_fixture(), all_fixture(), T0)
        self.assertTrue(any(".corrupt." in n for n in os.listdir(self.dir)))
        self.assertGreater(res["counts"]["total"], 0)

    def test_concurrent_builds_do_not_corrupt(self):
        store = U.Store(self.path)
        errs = []

        def worker(i):
            try:
                c = [(f"f0:00:00:00:{i:02x}:{j:02x}", f"10.0.{i}.{j}", f"d{i}-{j}", "iot") for j in range(5)]
                for k in range(5):
                    obs = U.observe(topo_fixture(extra_clients=c), all_fixture(), now=T0 + k)
                    U.build(obs, store, now=T0 + k, topo=topo_fixture(extra_clients=c))
                    store.save(force=True)
            except Exception as e:     # pragma: no cover
                errs.append(e)

        ts = [threading.Thread(target=worker, args=(i,)) for i in range(6)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(errs, [])
        with open(self.path) as f:
            d = json.load(f)
        slots = {}
        for bid, r in d["bodies"].items():
            key = (r["system"], r["shell"], r["slot"])
            self.assertNotIn(key, slots, f"{bid} collides with {slots.get(key)}")
            slots[key] = bid


# ---- layout -------------------------------------------------------------------------
GOLDEN_BODIES = [
    {"id": "mac:aa:bb:cc:dd:ee:ff", "system": "sys:home", "shell": 7, "slot": 17},
    {"id": "vm:pve2:101", "system": "sys:pve2", "shell": 3, "slot": 0},
    {"id": "vm:pve2:102", "system": "sys:pve2", "shell": 3, "slot": 85},
    {"id": "mac:00:5e:01:80:fc:cb", "system": "sys:core", "shell": 0, "slot": 0},
    {"id": "name:cloudflare", "system": None, "shell": 1, "slot": 1},
    {"id": "name:camera:patio", "system": "sys:remote", "shell": 11, "slot": 4},
]
GOLDEN_CAPS = {"sys:home": {"5": 4, "7": 18, "12": 2}, "sys:pve2": {"0": 1, "3": 86, "4": 18},
               "sys:core": {"0": 1, "1": 12}, "": {"1": 2}, "sys:remote": {"11": 5, "12": 9}}
for _b in GOLDEN_BODIES:
    _b["seed"] = U.hash32(_b["id"])


class TestLayout(unittest.TestCase):
    def test_hash32_known_values(self):
        self.assertEqual(U.hash32(""), 0x811C9DC5)
        self.assertEqual(U.hash32("a"), 0xE40C292C)          # FNV-1a reference vectors
        self.assertEqual(U.hash32("foobar"), 0xBF9CF968)

    def test_python_port_deterministic(self):
        for b in GOLDEN_BODIES:
            g = py_geometry(GOLDEN_CAPS[b["system"] or ""])
            self.assertEqual(py_place(b, g), py_place(dict(b), py_geometry(dict(GOLDEN_CAPS[b["system"] or ""]))))
        hub = GOLDEN_BODIES[3]
        self.assertEqual(py_place(hub, py_geometry(GOLDEN_CAPS["sys:core"])), (0.0, 0.0))

    def test_append_only_angles(self):
        """Growing a shell scales radii smoothly but never changes any slot's angle
        or its relative radial order."""
        sysid = "sys:home"
        small, big = {"7": 10}, {"7": 200}
        gs, gb = py_geometry(small), py_geometry(big)
        prev = None
        for n in range(10):
            b = {"system": sysid, "shell": 7, "slot": n, "seed": U.hash32(f"x{n}")}
            rs, ts = py_place(b, gs)
            rb, tb = py_place(b, gb)
            self.assertAlmostEqual(frac(0.5 + n * A2), frac(0.5 + n * A2))
            # angle shift only from the jitter term divided by r
            self.assertLess(abs(math.remainder(ts - tb, TAU)), 0.2)
        g1, g2 = py_geometry({"3": 50}), py_geometry({"3": 51})
        self.assertLess(abs(g2[3][1] - g1[3][1]), 0.05)        # smooth growth

    @unittest.skipUnless(NODE, "node not installed")
    def test_js_matches_python_and_is_deterministic(self):
        payload = json.dumps({"bodies": GOLDEN_BODIES, "caps": GOLDEN_CAPS,
                              "strings": ["", "a", "foobar", "mac:aa:bb", "héllo wörld ✓", "emoji 🚀"]})
        script = f"""
const L = require({json.dumps(LAYOUT_JS)});
const P = {payload};
const out = {{hash: P.strings.map(L.hash32), places: [], places2: [], shells: L.SHELL_OF_CLASS,
             caps: L.capacities(P.bodies), colour: P.bodies.map(b => L.colourFor(b, null))}};
for (const b of P.bodies) {{
  const g = L.geometry(P.caps[b.system === null ? "" : b.system]);
  out.places.push(L.place(b, g)); out.places2.push(L.place(Object.assign({{}}, b), L.geometry(P.caps[b.system === null ? "" : b.system])));
}}
console.log(JSON.stringify(out));
"""
        out = run_node(script)
        self.assertEqual(out["hash"], [U.hash32(s) for s in ["", "a", "foobar", "mac:aa:bb",
                                                              "héllo wörld ✓", "emoji 🚀"]])
        self.assertEqual(out["shells"], U.SHELL_OF_CLASS)
        self.assertEqual(out["places"], out["places2"])
        for b, p in zip(GOLDEN_BODIES, out["places"]):
            r, t = py_place(b, py_geometry(GOLDEN_CAPS[b["system"] or ""]))
            self.assertAlmostEqual(p["r"], r, places=9, msg=b["id"])
            self.assertAlmostEqual(p["theta"], t, places=9, msg=b["id"])
            self.assertTrue(all(math.isfinite(p[k]) for k in ("x", "y", "z", "phase", "scale")))
            self.assertRegex(out["colour"][GOLDEN_BODIES.index(b)], r"^#[0-9a-f]{6}$")

    @unittest.skipUnless(NODE, "node not installed")
    def test_quantized_growth_leaves_outer_shells_byte_identical(self):
        """Append one body to an inner shell, cap 1..200: outer-shell coordinates are
        byte-identical unless the inner shell crossed a quantization step."""
        out = run_node(f"""
const L = require({json.dumps(LAYOUT_JS)});
const outer = []; for (let i = 0; i < 40; i++) outer.push({{system: "sys:home", shell: 9, slot: i, seed: L.hash32("o" + i)}});
const res = [];
for (let c = 1; c <= 200; c++) {{
  const a = L.geometry(L.quantizeCaps({{"5": c, "9": 40}})), b = L.geometry(L.quantizeCaps({{"5": c + 1, "9": 40}}));
  const same = JSON.stringify(outer.map(o => L.place(o, a))) === JSON.stringify(outer.map(o => L.place(o, b)));
  const q = L.quantizeCaps({{"5": c}})["5"], q2 = L.quantizeCaps({{"5": c + 1}})["5"];
  res.push([c, same, q, q2]);
}}
console.log(JSON.stringify({{res, q0: L.quantizeCaps({{"3": 0, "4": 1, "7": 13}})}}));
""")
        def q(c):
            return 0 if c <= 0 else 8 * math.ceil((c + max(3, math.ceil(c / 4))) / 8)
        self.assertEqual(out["q0"], {"3": 0, "4": q(1), "7": q(13)})
        crossings = 0
        for c, same, qc, qc1 in out["res"]:
            self.assertEqual((qc, qc1), (q(c), q(c + 1)))
            if qc == qc1:
                self.assertTrue(same, f"outer moved at cap {c} without a step")
            else:
                crossings += 1
        self.assertLess(crossings, 40)      # 8-wide steps: ~1 move per 6 appends at the top end

    @unittest.skipUnless(NODE, "node not installed")
    def test_js_capacities_equal_server_shells(self):
        p = os.path.join(ROOT, "stage_api", "universe.json")
        if not os.path.exists(p):
            self.skipTest("no snapshot")
        out = run_node(f"""const L=require({json.dumps(LAYOUT_JS)});const r=require({json.dumps(p)});
const c=L.capacities(r.bodies);console.log(JSON.stringify(r.systems.map(s=>[JSON.stringify(c[s.id]||{{}}),JSON.stringify(s.shells)])));""")
        for a, b in out:
            self.assertEqual(json.loads(a), json.loads(b))


class TestSameDevice(unittest.TestCase):
    """Operator-declared merges (universe_same.json): the P1 Pro case."""

    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.same_path = os.path.join(self.d, "same.json")
        with open(self.same_path, "w") as f:
            json.dump({"groups": [{"canonical": "mac:0c:5e:02:01:8c:e9",
                                   "also": ["ip:10.0.0.100", "ip:10.0.0.120"]}]}, f)
        U._same_cache.update(mtime=None, map={})

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)
        U._same_cache.update(mtime=None, map={})

    def _obs(self):
        live = U.Obs("P1 Pro-8CE9", "printer", status="up", src=["unifi"],
                     mac="0c:5e:02:01:8c:e9", ip="10.0.0.212")
        old = U.Obs("p1-3dprinter", "printer", status="down", src=["snmp"],
                    ip="10.0.0.100", name="p1-3dprinter")
        hp = U.Obs("hp-printer", "printer", status="down", src=["snmp"],
                   ip="10.0.0.120", name="hp-printer")
        return live, old, hp

    def test_alias_observations_fold_into_the_live_device_whatever_the_order(self):
        same = U.load_same(self.same_path)
        for order in ((0, 1, 2), (1, 2, 0), (2, 0, 1)):
            obs = [self._obs()[i] for i in order]
            out = U.apply_same(obs, same)
            self.assertEqual(len(out), 1)
            self.assertEqual(out[0].label, "P1 Pro-8CE9")       # canonical stays the base
            self.assertEqual(out[0].status, "up")              # a stale `down` never wins
            self.assertEqual(out[0].ips[0], "10.0.0.212")

    def test_stored_alias_bodies_are_retired_and_their_slots_freed(self):
        store = {"bodies": {"mac:0c:5e:02:01:8c:e9": {"system": "sys:home", "shell": 10, "slot": 0},
                            "ip:10.0.0.100": {"system": "sys:home", "shell": 10, "slot": 1},
                            "ip:10.0.0.120": {"system": "sys:home", "shell": 10, "slot": 2}},
                 "alias": {"name:p1-3dprinter": "ip:10.0.0.100"}, "held": {}}
        self.assertTrue(U.merge_same_in_store(store, U.load_same(self.same_path)))
        self.assertEqual(list(store["bodies"]), ["mac:0c:5e:02:01:8c:e9"])
        self.assertEqual(store["alias"]["ip:10.0.0.100"], "mac:0c:5e:02:01:8c:e9")
        self.assertEqual(store["alias"]["name:p1-3dprinter"], "mac:0c:5e:02:01:8c:e9")
        self.assertEqual(store["bodies"]["mac:0c:5e:02:01:8c:e9"]["slot"], 0)   # canonical never moves

    def test_missing_or_broken_file_means_no_merges(self):
        self.assertEqual(U.load_same(os.path.join(self.d, "nope.json")), {})
        bad = os.path.join(self.d, "bad.json")
        with open(bad, "w") as f:
            f.write("{not json")
        self.assertEqual(U.load_same(bad), {})


# ---- ghost guards (2026-10-07 incident) -------------------------------------------
USW = "aa:00:00:00:00:02"
UDM = "aa:00:00:00:00:01"


def sta(mac, ip, port=None, sw=USW, wired=True, oui=None, hostname=None, name=None):
    c = {"mac": mac, "ip": ip, "is_wired": wired, "oui": oui, "hostname": hostname, "name": name}
    if wired:
        c.update(sw_mac=sw, sw_port=port)
    else:
        c["ap_mac"] = USW
    return c


class TestGhosts(Base):
    """2026-10-07 06:41-06:52 UTC: LAN path dropped, then the UDM served a SHORT
    station list. Strong bodies went unobserved, DHCP guests lost their IPs, the
    sweep reported those IPs as unknown and ~16 ip: bodies were minted."""

    GUEST = ("pve2", 200, "palworld-win", "qemu")

    def full(self):
        topo = topo_fixture(guests=(self.GUEST,))
        for n in topo["nodes"]:
            if n["id"] == "guest:pve2:200":
                n["ip"] = "10.0.0.47"            # DHCP guest: ip via UniFi MAC->IP
        stas = [sta("0c:5e:03:09:da:e0", "10.0.0.105", wired=False, hostname="Govee H6076"),
                sta("00:5e:04:cf:c5:81", "10.0.0.109", wired=False, name="Midea washer"),
                sta("bc:24:11:00:00:c8", "10.0.0.47", port=16)]
        return topo, stas

    def outage(self):
        topo = topo_fixture(guests=(self.GUEST,))          # guest lost its ip
        return topo, []                                     # short station list

    def test_partial_station_list_after_outage_does_not_mint_ghosts(self):
        """Reproduces the incident: before the fix this minted ip:10.0.0.105,
        ip:10.0.0.109 and ip:10.0.0.47."""
        gm = {("pve2", 200): "bc:24:11:00:00:c8"}
        topo, stas = self.full()
        res1, store = self.build(topo, all_fixture(), T0, stas=stas, gmac=gm)
        before = {b["id"]: (b["system"], b["shell"], b["slot"]) for b in res1["bodies"]}
        topo2, stas2 = self.outage()
        res2, _ = self.build(topo2, all_fixture(unknown=["10.0.0.105", "10.0.0.109", "10.0.0.47"]),
                             T0 + 300, store=store, stas=stas2, gmac=gm)
        ids = self.by_id(res2)
        ghosts = [i for i in ids if i in ("ip:10.0.0.105", "ip:10.0.0.109", "ip:10.0.0.47")]
        self.assertEqual(ghosts, [], ghosts)
        self.assertEqual(ids["mac:0c:5e:03:09:da:e0"]["status"], "up")       # answered the sweep
        self.assertEqual(ids["mac:0c:5e:03:09:da:e0"]["label"], "Govee H6076")  # never renamed
        self.assertIn("probe", ids["vm:pve2:200"]["src"])
        after = {b["id"]: (b["system"], b["shell"], b["slot"]) for b in res2["bodies"]}
        self.assertEqual(before, after)
        # and when the feeds recover, nothing moved or reclassified
        res3, _ = self.build(topo, all_fixture(), T0 + 900, store=store, stas=stas, gmac=gm)
        self.assertEqual(before, {b["id"]: (b["system"], b["shell"], b["slot"]) for b in res3["bodies"]})
        self.assertEqual(self.by_id(res3)["mac:0c:5e:03:09:da:e0"]["class"],
                         self.by_id(res1)["mac:0c:5e:03:09:da:e0"]["class"])

    def test_restart_with_unifi_late_warm_gate_gave_up(self):
        """Restart (new Store object on the same file) while UniFi has not answered:
        the warming gate gives up after WARM_MAX_S and the build is degraded. A
        never-seen IP-only host is not minted (it is listed in `excluded`); known
        addresses fold into their owners."""
        gm = {("pve2", 200): "bc:24:11:00:00:c8"}
        topo, stas = self.full()
        _, store = self.build(topo, all_fixture(), T0, stas=stas, gmac=gm)
        n_before = len(store.data["bodies"])
        restarted = U.Store(self.path)                       # process restart
        topo2, _ = self.outage()
        alld = all_fixture(unknown=["10.0.0.105", "10.0.0.47", "10.0.0.123"])
        why = U.degraded_state({"topology": topo2}, None, T0 + 400, warm_gave_up=True)
        self.assertIn("warming gate gave up", why)
        excluded = []
        obs = U.observe(topo2, alld, now=T0 + 400, excluded=excluded)
        res = U.build(obs, restarted, now=T0 + 400, topo=topo2, excluded=excluded, degraded=why)
        ids = self.by_id(res)
        self.assertFalse([i for i in ids if i in ("ip:10.0.0.105", "ip:10.0.0.47", "ip:10.0.0.123")])
        self.assertEqual(len(restarted.data["bodies"]), n_before)
        self.assertEqual(res["degraded"], why)
        self.assertIn("10.0.0.123", [e["key"] for e in res["excluded"]])
        # degraded lingers for the grace period, then a genuinely new host is minted
        self.assertTrue(U.degraded_state({"topology": topo2}, None, T0 + 500).startswith("recovering"))
        self.assertIsNone(U.degraded_state({"topology": topo2}, None, T0 + 400 + U.DEGRADED_GRACE_S + 1))
        res2 = U.build(U.observe(topo2, alld, now=T0 + 1100), restarted, now=T0 + 1100, topo=topo2)
        self.assertIn("ip:10.0.0.123", self.by_id(res2))
        U._deg.update(until=0.0, why=None, sta=[])

    def test_short_station_list_is_a_degraded_signal(self):
        U._deg.update(until=0.0, why=None, sta=[])
        tm = mock.Mock(_pve_state={"stale_nodes": []}, _last_stas=[{}] * 110)
        topo = {"nodes": [{"id": "unifi:x", "kind": "gateway", "status": "up"}]}
        self.assertIsNone(U.degraded_state({"topology": topo}, tm, T0))
        tm._last_stas = [{}] * 99
        self.assertIn("short (99 of 110)", U.degraded_state({"topology": topo}, tm, T0 + 60))
        topo["nodes"][0]["status"] = "unknown"
        self.assertIn("unifi devices stale", U.degraded_state({"topology": topo}, tm, T0 + 120))
        U._deg.update(until=0.0, why=None, sta=[])

    def test_gateway_wan_and_lan_addresses_never_become_bodies(self):
        """05:19 UTC: the UDM's WAN address moved (failover); the sweep then saw
        10.0.9.1 / 10.0.9.2 as unknown and minted them."""
        topo = topo_fixture()
        res1, store = self.build(topo, all_fixture(), T0, gw_lan=("10.0.0.1",))
        topo2 = topo_fixture()
        for n in topo2["nodes"]:
            if n["kind"] in ("wan", "gateway"):
                n["ip"] = "10.0.200.1" if n["kind"] == "wan" else "10.0.200.2"
        res2, _ = self.build(topo2, all_fixture(unknown=["10.0.9.1", "10.0.9.2", "10.0.0.1"]),
                             T0 + 3 * DAY, store=store, gw_lan=("10.0.0.1",))
        self.assertFalse([b["id"] for b in res2["bodies"]
                          if b["id"] in ("ip:10.0.9.1", "ip:10.0.9.2", "ip:10.0.0.1")])

    def test_vip_named_like_one_device_folds_into_it(self):
        """LibreNMS lists a dead Zabbix VIP (10.0.0.130) named 'Zabbix'."""
        topo = topo_fixture(guests=(("pve2", 115, "Zabbix", "qemu"),))
        _, store = self.build(topo, all_fixture(), T0)
        res, _ = self.build(topo, all_fixture(netmap=[("10.0.0.130", "Zabbix", "container", 0)]),
                            T0 + 60, store=store)
        ids = self.by_id(res)
        self.assertNotIn("ip:10.0.0.130", ids)
        self.assertIn("snmp", ids["vm:pve2:115"]["src"])
        self.assertEqual(ids["vm:pve2:115"]["status"], "up")    # a down VIP never lowers it

    def test_randomised_mac_with_a_named_devices_hostname_folds(self):
        topo = topo_fixture(extra_clients=[("fc:00:00:00:00:01", "10.0.0.30", "P1 Pro-8CE9", "3dprinter")])
        res1, store = self.build(topo, all_fixture(), T0)
        k1 = self.by_id(res1)["mac:fc:00:00:00:00:01"]
        known = [{"mac": "02:5e:05:aa:b8:c5", "hostname": "P1 Pro-8CE9", "last_seen": T0, "is_wired": True}]
        res2, _ = self.build(topo_fixture(), all_fixture(), T0 + 60, store=store, known=known)  # P1 asleep
        ids = self.by_id(res2)
        self.assertNotIn("mac:02:5e:05:aa:b8:c5", ids)
        self.assertEqual(store.data["alias"]["mac:02:5e:05:aa:b8:c5"], "mac:fc:00:00:00:00:01")
        self.assertEqual((ids[k1["id"]]["shell"], ids[k1["id"]]["slot"]), (k1["shell"], k1["slot"]))
        # a randomised MAC with a GENERIC name is still its own (phone) body
        known2 = [{"mac": "2a:00:00:00:00:09", "hostname": "iPhone", "last_seen": T0}]
        res3, _ = self.build(topo_fixture(), all_fixture(), T0 + 120, store=store, known=known2)
        self.assertIn("mac:2a:00:00:00:00:09", self.by_id(res3))

    def test_ip_claimed_by_two_bodies_is_not_folded_and_strong_never_merge(self):
        t1 = topo_fixture(extra_clients=[("ee:00:00:00:00:01", "10.0.0.88", "a", "phone")])
        _, store = self.build(t1, all_fixture(), T0)
        t2 = topo_fixture(extra_clients=[("ee:00:00:00:00:02", "10.0.0.88", "b", "phone")])
        self.build(t2, all_fixture(), T0 + 60, store=store)
        res, _ = self.build(topo_fixture(), all_fixture(unknown=["10.0.0.88"]), T0 + 120, store=store)
        ids = self.by_id(res)
        self.assertIn("ip:10.0.0.88", ids)                   # ambiguous owner: its own body
        self.assertNotEqual(ids["mac:ee:00:00:00:00:01"]["slot"], ids["mac:ee:00:00:00:00:02"]["slot"])

    def test_ip_claim_expires(self):
        t1 = topo_fixture(extra_clients=[("ee:00:00:00:00:01", "10.0.0.88", "a", "phone")])
        _, store = self.build(t1, all_fixture(), T0)
        res, _ = self.build(topo_fixture(), all_fixture(unknown=["10.0.0.88"]),
                            T0 + U.IP_CLAIM_S + 60, store=store)
        self.assertIn("ip:10.0.0.88", self.by_id(res))

    def test_orphan_body_whose_key_aliases_elsewhere_is_retired(self):
        store = {"bodies": {"vm:pve1:260": {"system": "sys:pve1", "shell": 3, "slot": 8},
                            "mac:bc:24:11:b5:91:f8": {"system": "sys:home", "shell": 2, "slot": 1}},
                 "alias": {"mac:bc:24:11:b5:91:f8": "vm:pve1:260", "vm:pve1:260": "vm:pve1:260"}, "held": {}}
        self.assertEqual(U.retire_orphans(store), ["mac:bc:24:11:b5:91:f8"])
        self.assertEqual(list(store["bodies"]), ["vm:pve1:260"])
        self.assertEqual(store["bodies"]["vm:pve1:260"]["slot"], 8)


# ---- switches -----------------------------------------------------------------------
class TestSwitches(Base):
    def sw_build(self, stas, now=T0, store=None, known=None, devices=None, declared=None, extra=(), **kw):
        topo = topo_fixture(extra_clients=extra)
        res, store = self.build(topo, all_fixture(), now, store=store, stas=stas, known=known,
                                devices=devices, declared=declared, **kw)
        return res, store

    def test_vendor_classification(self):
        stas = [sta("04:5e:06:10:cc:b7", "10.0.0.50", 12, oui="Alcatel-Lucent"),
                sta("00:5e:07:b3:68:3f", "10.0.0.55", 11, oui="Juniper Networks", hostname="iPhone"),
                sta("00:5e:08:00:00:01", "10.0.0.60", 3, oui="TP-LINK TECHNOLOGIES CO.,LTD."),
                sta("00:5e:08:00:00:02", "10.0.0.61", 4, oui="TP-LINK TECHNOLOGIES CO.,LTD.", hostname="TL-SG108E"),
                sta("0c:5e:09:37:18:e0", "10.0.0.157", 7, oui="Netgear", hostname="R7900P"),
                sta("08:5e:0a:00:00:01", "10.0.0.62", 5, oui="Nintendo Co.,Ltd", hostname="Switch"),
                sta("08:5e:0b:00:00:01", "10.0.0.63", wired=False, oui="Cisco Systems, Inc", hostname="iPhone")]
        res, _ = self.sw_build(stas, client_cat=lambda n, h, o, w, m, ip: ("phone", None) if (h or "").lower() == "iphone" else ("unknown", None))
        ids = self.by_id(res)
        cls = {k: ids["mac:" + k]["class"] for k in ("04:5e:06:10:cc:b7", "00:5e:07:b3:68:3f", "00:5e:08:00:00:01",
                                                     "00:5e:08:00:00:02", "0c:5e:09:37:18:e0", "08:5e:0a:00:00:01",
                                                     "08:5e:0b:00:00:01")}
        self.assertEqual(cls["04:5e:06:10:cc:b7"], "switch")        # tier A vendor, wired
        self.assertEqual(cls["00:5e:07:b3:68:3f"], "network_device")  # Juniper alone: never a phone, not yet a switch
        self.assertNotEqual(cls["00:5e:08:00:00:01"], "switch")     # consumer vendor, no clue
        self.assertEqual(cls["00:5e:08:00:00:02"], "switch")        # consumer vendor + switch model name
        self.assertNotEqual(cls["0c:5e:09:37:18:e0"], "switch")     # a router
        self.assertNotEqual(cls["08:5e:0a:00:00:01"], "switch")     # a Nintendo Switch
        self.assertNotEqual(cls["08:5e:0b:00:00:01"], "switch")     # wireless
        self.assertNotEqual(cls["08:5e:0b:00:00:01"], "phone")      # Cisco MAC: never a phone
        sw = ids["mac:04:5e:06:10:cc:b7"]
        self.assertTrue(sw["hub"])
        self.assertEqual(sw["label"], "Alcatel-Lucent switch")
        self.assertEqual(sw["parent"], "mac:" + USW)
        self.assertEqual((sw["m"]["uplink_mac"], sw["m"]["uplink_port"]), (USW, 12))
        self.assertEqual(sw["system"], "sys:core")

    def test_lldp_neighbour_misread_as_phone_is_promoted_once(self):
        """The Juniper EX2200: UniFi calls it 'iPhone' (phone) but it is the LLDP
        neighbour on USW port 11. It moves ONCE to the switch ring; the old slot
        is held, every other body stays put; hosts on that port hang off it."""
        cc = lambda n, h, o, w, m, ip: ("phone", None) if (h or "").lower() == "iphone" else ("unknown", None)
        # the live store minted it as a phone back when UniFi gave no vendor string
        stas = [sta("00:5e:07:b3:68:3f", "10.0.0.55", 11, hostname="iPhone"),
                sta("f0:00:00:00:00:01", "10.0.0.70", 3, hostname="phone-a", wired=False)]
        res1, store = self.sw_build(stas, client_cat=cc)
        self.assertEqual(self.by_id(res1)["mac:00:5e:07:b3:68:3f"]["class"], "phone")
        stas[0]["oui"] = "Juniper Networks"
        before = {b["id"]: (b["system"], b["shell"], b["slot"]) for b in res1["bodies"]}
        devices = [{"mac": USW, "lldp_table": [{"chassis_id": "00:5e:07:b3:68:00", "local_port_idx": 11,
                                                "mgmt_ips": ["10.0.0.55"], "port_id": "34"}]}]
        stas2 = stas + [sta("00:5e:0c:00:00:01", "10.0.0.101", 11, oui="Some Vendor")]
        res2, _ = self.sw_build(stas2, T0 + 60, store=store, devices=devices, client_cat=cc)
        ids = self.by_id(res2)
        j = ids["mac:00:5e:07:b3:68:3f"]
        self.assertEqual((j["class"], j["system"], j["shell"]), ("switch", "sys:core", 1))
        self.assertEqual(j["label"], "Juniper switch")
        self.assertIn("lldp", j["src"])
        self.assertEqual(store.data["alias"]["mac:00:5e:07:b3:68:00"], j["id"])     # LLDP chassis id
        old = before[j["id"]]
        self.assertIn(str(old[2]), store.data["held"][f"{old[0]}|{old[1]}"])
        for bid, pos in before.items():
            if bid != j["id"]:
                self.assertEqual(pos, (ids[bid]["system"], ids[bid]["shell"], ids[bid]["slot"]), bid)
        self.assertEqual(ids["mac:00:5e:0c:00:00:01"]["parent"], j["id"])
        links = {(l["a"], l["b"]) for l in res2["links"]}
        self.assertIn((j["id"], "mac:00:5e:0c:00:00:01"), links)
        self.assert_parents_resolve(res2)
        # promotion happens once: a later build does not move it again
        res3, _ = self.sw_build(stas2, T0 + 120, store=store, devices=devices, client_cat=cc)
        self.assertEqual(self.by_id(res3)[j["id"]]["slot"], j["slot"])

    def test_chassis_macs_fold_into_the_oldest_body(self):
        """Cisco: 9a and c0 were bodies since day one ('Cisco (remote)', c0 on a
        non-LAN 10.x address); 9c showed up later at .53. One chassis = one body,
        the oldest keeps its slot; a far-away MAC of the same OUI stays separate."""
        s1 = [sta("08:5e:0b:99:83:9a", None, 22, oui="Cisco Systems, Inc"),
              sta("08:5e:0b:99:83:c0", "10.0.207.105", 22, oui="Cisco Systems, Inc"),
              sta("08:5e:0b:10:00:00", "10.0.0.90", 2, oui="Cisco Systems, Inc")]
        res1, store = self.sw_build(s1)
        b1 = self.by_id(res1)
        keep = b1["mac:08:5e:0b:99:83:9a"]
        known = [{"mac": m, "oui": "Cisco Systems, Inc", "is_wired": True, "last_seen": T0, "last_ip": ip}
                 for m, ip in (("08:5e:0b:99:83:9a", None), ("08:5e:0b:99:83:c0", "10.0.207.105"))]
        s2 = [sta("08:5e:0b:99:83:9c", "10.0.0.53", 23, oui="Cisco Systems, Inc"),
              sta("08:5e:0b:10:00:00", "10.0.0.90", 2, oui="Cisco Systems, Inc"),
              sta("cc:00:00:00:00:01", "10.0.0.91", 2)]
        res2, _ = self.sw_build(s2, T0 + 60, store=store, known=known)
        ids = self.by_id(res2)
        self.assertNotIn("mac:08:5e:0b:99:83:c0", ids)
        self.assertNotIn("mac:08:5e:0b:99:83:9c", ids)
        c = ids["mac:08:5e:0b:99:83:9a"]
        self.assertEqual((c["system"], c["shell"], c["slot"]), (keep["system"], keep["shell"], keep["slot"]))
        self.assertEqual(c["class"], "switch")
        self.assertEqual(c["status"], "up")
        self.assertEqual(sorted(c["m"]["chassis_macs"]),
                         ["08:5e:0b:99:83:9a", "08:5e:0b:99:83:9c", "08:5e:0b:99:83:c0"])
        self.assertIn("mac:08:5e:0b:10:00:00", ids)                     # another box
        self.assertEqual(store.data["alias"]["mac:08:5e:0b:99:83:c0"], c["id"])

    def test_two_chassis_on_different_lan_subnets_stay_apart(self):
        stas = [sta("04:5e:06:00:00:01", "10.0.0.50", 12, oui="Alcatel-Lucent"),
                sta("04:5e:06:00:00:05", "10.0.3.50", 13, oui="Alcatel-Lucent")]
        res, _ = self.sw_build(stas)
        ids = self.by_id(res)
        self.assertIn("mac:04:5e:06:00:00:01", ids)
        self.assertIn("mac:04:5e:06:00:00:05", ids)

    def test_inferred_unmanaged_switch(self):
        """UDM port 7: 8 wired clients that are not guests. Proxmox host ports and
        guests never produce one; a port with < 3 clients does not either."""
        topo = topo_fixture()
        topo["nodes"][3]["ip"] = "10.0.0.238"                            # pve host
        kids = [sta(f"d0:00:00:00:00:{i:02x}", f"10.0.0.{60 + i}", 7, sw=UDM, hostname=f"dev{i}") for i in range(4)]
        pve = [sta("08:5e:0d:00:00:01", "10.0.0.238", 16)] + \
              [sta(f"bc:24:11:00:00:{i:02x}", f"10.0.0.{80 + i}", 16, oui="Proxmox Server Solutions GmbH") for i in range(5)]
        two = [sta(f"d1:00:00:00:00:{i:02x}", f"10.0.0.{90 + i}", 9) for i in range(2)]
        res, store = self.build(topo, all_fixture(), T0, stas=kids + pve + two)
        ids = self.by_id(res)
        sid = f"inferred:switch:{UDM}:7"
        self.assertEqual([i for i in ids if i.startswith("inferred:")], [sid])
        s = ids[sid]
        self.assertEqual((s["class"], s["system"], s["shell"], s["hub"]), ("switch", "sys:core", 1, True))
        self.assertTrue(s["m"]["inferred"])
        self.assertEqual(s["label"], "Switch on UDM port 7")
        self.assertEqual(s["parent"], "mac:" + UDM)
        self.assertNotIn("topo", s)
        for i in range(4):
            self.assertEqual(ids[f"mac:d0:00:00:00:00:{i:02x}"]["parent"], sid)
        links = {(l["a"], l["b"]) for l in res["links"]}
        self.assertIn(("mac:" + UDM, sid), links)
        self.assertIn((sid, "mac:d0:00:00:00:00:00"), links)
        self.assert_parents_resolve(res)
        # growth-stable: same id, same slot on the next build; more devices don't move it
        res2, _ = self.build(topo, all_fixture(), T0 + 60, store=store,
                             stas=kids + pve + two + [sta("d2:00:00:00:00:01", "10.0.0.99", 5)])
        self.assertEqual((self.by_id(res2)[sid]["shell"], self.by_id(res2)[sid]["slot"]), (s["shell"], s["slot"]))

    def assert_parents_resolve(self, res):
        bodies = {b["id"]: b for b in res["bodies"]}
        for b in res["bodies"]:
            p = b["parent"]
            if p and p in bodies:
                self.assertTrue("topo" in bodies[p] or bodies[p].get("hub"), (b["id"], p))


class TestDeclared(Base):
    def setUp(self):
        super().setUp()
        U._declared_cache.update(mtime=None, list=[])

    def test_declared_devices(self):
        p = os.path.join(self.dir, "declared.json")
        with open(p, "w") as f:
            json.dump({"devices": [
                {"id": "declared:switch:garage", "label": "Garage switch", "class": "switch",
                 "parent": "unifi:" + USW, "children_macs": ["d0:00:00:00:00:01"]},
                {"id": "declared:switch:juniper", "label": "Juniper EX2200", "class": "switch",
                 "mac": "00:5e:07:b3:68:3f"},
                {"label": "no id: ignored"}]}, f)
        decl = U.load_declared(p)
        self.assertEqual(len(decl), 2)
        stas = [sta("d0:00:00:00:00:01", "10.0.0.60", 3),
                sta("00:5e:07:b3:68:3f", "10.0.0.55", 11, oui="Juniper Networks")]
        res1, store = self.build(topo_fixture(), all_fixture(), T0, stas=stas)
        jid = "mac:00:5e:07:b3:68:3f"
        self.assertIn(jid, self.by_id(res1))
        res, _ = self.build(topo_fixture(), all_fixture(), T0 + 60, store=store, stas=stas, declared=decl)
        ids = self.by_id(res)
        g = ids["declared:switch:garage"]
        self.assertEqual((g["class"], g["status"], g["hub"], g["parent"]), ("switch", "unknown", True, "mac:" + USW))
        self.assertEqual(g["src"], ["declared"])
        self.assertEqual(ids["mac:d0:00:00:00:00:01"]["parent"], "declared:switch:garage")
        j = ids[jid]                                     # existing body keeps its id and slot
        self.assertNotIn("declared:switch:juniper", ids)
        self.assertEqual((j["label"], j["class"], j["system"], j["shell"]), ("Juniper EX2200", "switch", "sys:core", 1))
        self.assertEqual(len([b for b in res["bodies"] if b["class"] == "switch"]), 3)   # USW, Juniper, garage
        self.assertIn("declared", j["src"])
        self.assertEqual(store.data["alias"]["declared:switch:juniper"], jid)

    def test_missing_or_broken_declared_file_is_a_noop(self):
        self.assertEqual(U.load_declared(os.path.join(self.dir, "nope.json")), [])
        bad = os.path.join(self.dir, "bad.json")
        with open(bad, "w") as f:
            f.write("[oops")
        self.assertEqual(U.load_declared(bad), [])


class TestSameDeviceStrong(unittest.TestCase):
    def test_ip_alias_never_folds_a_different_mac(self):
        """The ADVA FSP 150 (MAC 00:80:ea:..) now holds 10.0.0.100, an old P1 Pro
        address listed in universe_same.json: it must stay its own device."""
        same = {"ip:10.0.0.100": "mac:0c:5e:02:01:8c:e9"}
        k1 = U.Obs("P1 Pro-8CE9", "printer", "up", ["unifi"], mac="0c:5e:02:01:8c:e9", ip="10.0.0.212")
        adva = U.Obs("FSP150CC-GE114H", "network_device", "up", ["unifi"], mac="00:5e:0c:db:69:d1", ip="10.0.0.100")
        old = U.Obs("p1-3dprinter", "printer", "down", ["snmp"], ip="10.0.0.100")
        out = U.apply_same([k1, adva, old], same)
        self.assertEqual(len(out), 2)
        self.assertNotIn("00:5e:0c:db:69:d1", out[0].macs)

    def test_live_alias_sighting_brings_its_address_to_a_stale_canonical(self):
        same = {"mac:00:5e:0c:db:69:d1": "ip:10.0.0.101"}
        stale = U.Obs("ont-fsp150", "network_device", "down", ["snmp"], ip="10.0.0.101", m={"ip": "10.0.0.101"})
        live = U.Obs("FSP150CC-GE114H", "network_device", "up", ["unifi"], mac="00:5e:0c:db:69:d1",
                     ip="10.0.0.100", m={"ip": "10.0.0.100"})
        out = U.apply_same([stale, live], same)
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0].label, out[0].status, out[0].ips[0], out[0].m["ip"]),
                         ("ont-fsp150", "up", "10.0.0.100", "10.0.0.100"))



# ---- traffic (CONTRACTS section 6) ------------------------------------------------------
AP = "aa:00:00:00:00:03"
NB_HOST = "08:5e:0d:00:00:01"
GPU_HOST = "08:5e:0d:00:00:02"
G101 = "bc:24:11:00:00:65"           # pve2 guest 101 (pihole)
G121 = "bc:24:11:00:00:79"           # pve2 guest 121 (proxmox-backup-server)
G113 = "bc:24:11:00:00:71"           # pve1 guest 113 (frigate)
PHONE = "cc:00:00:00:00:01"          # wireless, sys:home
CAM = "ec:71:db:00:00:01"            # Reolink alone on UDM port 1, sys:home
LAMP = "dd:00:00:00:00:05"           # alone on USW port 5, sys:home
TUN = [{"host": "udm-a", "if": "wgsts1000", "local": "sys:core", "remote": "sys:branch",
        "local_ip": "10.0.9.2", "remote_ip": "10.0.3.1", "label": "WireGuard core-branch"},
       {"host": "udm-branch", "if": "wgsts1001", "local": "sys:branch", "remote": "sys:remote",
        "local_ip": "10.0.3.1", "remote_ip": "10.0.2.1", "label": "WireGuard branch-remote"}]
GMAC = {("pve2", 101): G101, ("pve2", 121): G121, ("pve1", 113): G113}


class World:
    """Synthetic UniFi stat/device + stat/sta rows and ntopng flows whose cumulative
    counters grow at the configured byte rates (bytes/s), timed like the live UDM."""

    def __init__(self):
        # (device, port) -> [rx Bps (from the attached side), tx Bps (to it)]
        self.ports = {(USW, 16): [50_000.0, 1_000_000.0], (USW, 13): [2_000_000.0, 300_000.0],
                      (UDM, 1): [900_000.0, 40_000.0], (USW, 5): [100.0, 600.0], (UDM, 10): [5.0e6, 5.0e6]}
        # client mac -> [rx Bps (from the client), tx Bps (to it)]
        self.sta = {NB_HOST: [1_000.0, 2_000.0], G101: [3_000.0, 4_000.0], G121: [10.0, 10.0],
                    GPU_HOST: [500.0, 500.0], G113: [700.0, 700.0], PHONE: [20_000.0, 150_000.0],
                    CAM: [900_000.0, 40_000.0], LAMP: [10.0, 70.0]}
        self.wan = [1_500_000.0, 120_000.0]
        self.flows = []                  # (src topo, dst topo, src ip, dst ip, bps, proto, internal)
        self.base = {}
        self.frozen = set()              # reporters that stopped reporting

    def c(self, key, rate, t):
        return self.base.setdefault(key, 10_000_000.0) + rate * (t - T0)

    def devices(self, t):
        rows = []
        for mac, typ in ((UDM, "udm"), (USW, "usw"), (AP, "uap")):
            ts = T0 if mac in self.frozen else t
            d = {"mac": mac, "type": typ, "last_seen": ts, "port_table": []}
            for (dev, idx), (rx, tx) in self.ports.items():
                if dev == mac:
                    d["port_table"].append({"port_idx": idx, "up": True, "rx_bytes": self.c((dev, idx, "rx"), rx, ts),
                                            "tx_bytes": self.c((dev, idx, "tx"), tx, ts)})
            if typ == "udm":
                d["wan1"] = {"up": True, "rx_bytes": self.c("wan.rx", self.wan[0], ts),
                             "tx_bytes": self.c("wan.tx", self.wan[1], ts)}
                d["wan2"] = {"up": None, "rx_bytes": None, "tx_bytes": None}
            rows.append(d)
        return rows

    def stas(self, t):
        where = {NB_HOST: ("10.0.0.238", USW, 16), G101: ("10.0.0.65", USW, 16), G121: ("10.0.0.7", USW, 16),
                 GPU_HOST: ("10.0.0.38", USW, 13), G113: ("10.0.0.185", USW, 13), CAM: ("10.0.0.26", UDM, 1),
                 LAMP: ("10.0.0.75", USW, 5), PHONE: ("10.0.0.50", None, None)}
        rows = []
        for mac, (rx, tx) in self.sta.items():
            ip, sw, port = where[mac]
            wired = sw is not None
            c = sta(mac, ip, port, sw=sw or USW, wired=wired, hostname={CAM: "server", LAMP: "lamp", PHONE: "phone"}.get(mac))
            if not wired:
                c["ap_mac"] = AP
            c["last_seen"] = t
            pre = "wired-" if wired else ""
            c[pre + "rx_bytes"], c[pre + "tx_bytes"] = self.c((mac, "rx"), rx, t), self.c((mac, "tx"), tx, t)
            rows.append(c)
        return rows

    def topo(self, now):
        topo = topo_fixture(guests=(("pve2", 101, "pihole", "lxc"), ("pve2", 121, "proxmox-backup-server", "lxc"),
                                    ("pve1", 113, "frigate", "lxc")),
                            extra_clients=[(CAM, "10.0.0.26", "server", "unknown"), (LAMP, "10.0.0.75", "lamp", "smart-home"),
                                           (PHONE, "10.0.0.50", "phone", "phone")])
        topo["nodes"].append({"id": "unifi:" + AP, "kind": "ap", "label": "U7 Pro", "ip": "10.0.0.39",
                              "parent": "unifi:" + UDM, "rx": 1, "tx": 1, "measured": True, "status": "up", "meta": {}})
        topo["nodes"].append({"id": "pve:pve1", "kind": "pvehost", "label": "pve1", "ip": "10.0.0.38",
                              "parent": "unifi:" + USW, "rx": 0, "tx": 0, "measured": True, "status": "up", "meta": {}})
        for n in topo["nodes"]:
            if n["id"] == "guest:pve2:121":
                n["ip"] = "10.0.0.7"
            if n["id"] == "guest:pve1:113":
                n["ip"] = "10.0.0.185"
        topo["flows"] = [{"src": a, "dst": b, "src_ip": ai, "dst_ip": bi, "bps": bps, "proto": p, "internal": i,
                          "measured": True, "src_label": a, "dst_label": bi} for a, b, ai, bi, bps, p, i in self.flows]
        topo["flow_meta"] = {"up": True, "ts": now, "shown": len(self.flows)}
        return topo

    def alld(self):
        return all_fixture(netmap=[("10.0.3.1", "udm-pro-se-Branch", "network", 1), ("10.0.2.1", "remote-gw", "network", 1)])


class TestTraffic(Base):
    def run_world(self, w, steps=6, dt=20.0, tunnels=None, state=None, t0=T0, store=None, tun_values=None):
        st = state or U.TrafficState()
        now = t0
        for i in range(steps):
            now = t0 + i * dt
            U.traffic_sample(st, now + 0.5, devices=w.devices(now), stas=w.stas(now), topo=w.topo(now + 0.5),
                             tunnels=tun_values(now) if tun_values else None)
        topo = w.topo(now + 0.5)
        res, store = self.build(topo, w.alld(), now + 1, store=store, stas=w.stas(now), gmac=GMAC,
                                devices=None, traffic={"state": st, "tunnels": TUN if tunnels is None else tunnels})
        return res, st, store

    def build(self, topo, alld, now, store=None, fresh=True, traffic=None, **kw):
        store = store or U.Store(self.path)
        obs = U.observe(topo, alld, now=now, **kw)
        return U.build(obs, store, now=now, fresh=fresh, topo=topo, traffic=traffic, names={}), store

    @staticmethod
    def pairs(res):
        return {(p["a"], p["b"]): p for p in res["traffic"]["pairs"]}

    def test_trunk_port_pair_with_measured_direction(self):
        res, _, _ = self.run_world(World())
        p = self.pairs(res)[("sys:core", "sys:pve2")]
        # USW port 16 rx 50 kB/s (host -> switch), tx 1 MB/s (switch -> host)
        self.assertEqual(p["bps"], (50_000 + 1_000_000) * 8.0)
        self.assertEqual(p["a_to_b_bps"], 1_000_000 * 8.0)          # core -> pve2
        self.assertEqual(p["b_to_a_bps"], 50_000 * 8.0)
        self.assertEqual((p["layer"], p["src"], p["links"], p["kind"]), ("interface", ["unifi_port"], 1, "lan"))
        self.assertNotIn("partial", p)
        # the guests' own counters on that port are a breakdown, never added on top
        self.assertEqual(p["top"][0]["src"], "unifi_port")
        self.assertIn("(client)", " ".join(t["label"] for t in p["top"][1:]))
        g = self.pairs(res)[("sys:core", "sys:pve1")]
        self.assertEqual((g["a_to_b_bps"], g["b_to_a_bps"]), (300_000 * 8.0, 2_000_000 * 8.0))

    def test_unmeasured_is_absent_never_zero(self):
        w = World()
        res, _, _ = self.run_world(w, tunnels=[])
        pairs = self.pairs(res)
        for k in pairs:
            self.assertNotIn("sys:remote", k)                 # NVR + gateway exist, nothing measures them
            self.assertNotIn("sys:branch", k)
        # no traffic state at all: no `traffic` key; an empty state: present but empty
        res2, _ = self.build(w.topo(T0), w.alld(), T0, stas=w.stas(T0), gmac=GMAC)
        self.assertNotIn("traffic", res2)
        res3, _ = self.build(w.topo(T0), w.alld(), T0, stas=w.stas(T0), gmac=GMAC,
                             traffic={"state": U.TrafficState(), "tunnels": TUN})
        self.assertEqual((res3["traffic"]["pairs"], res3["traffic"]["wan"]), ([], []))
        self.assertEqual(res3["traffic"]["window_s"], U.TRAFFIC_WINDOW_S)

    def test_shared_and_lone_ports_never_double_count(self):
        res, _, _ = self.run_world(World())
        p = self.pairs(res)[("sys:core", "sys:home")]
        # camera alone on UDM port 1 -> the port; lamp alone on USW port 5 -> the port;
        # the wireless phone -> its own counters at the AP
        exp_ab = (40_000 + 600 + 150_000) * 8.0            # core -> home
        exp_ba = (900_000 + 100 + 20_000) * 8.0            # home -> core
        self.assertEqual((p["a_to_b_bps"], p["b_to_a_bps"]), (exp_ab, exp_ba))
        self.assertEqual(p["bps"], exp_ab + exp_ba)
        self.assertEqual(p["links"], 3)
        self.assertEqual(sorted(p["src"]), ["unifi_port", "unifi_sta"])
        labels = [t["label"] for t in p["top"]]
        self.assertFalse([l for l in labels if "(client)" in l])   # a lone client is not repeated
        self.assertEqual(p["kind"], "media")                        # the camera dominates

    def test_flow_pairs_are_partial_without_direction(self):
        w = World()
        w.flows = [("pve:pve1", "pve:pve2", "10.0.0.38", "10.0.0.238", 400_000.0, "NFS", True),
                   ("guest:pve2:101", "guest:pve1:113", "10.0.0.65", "10.0.0.185", 50_000.0, "HTTP.WebSocket", True),
                   ("guest:pve2:101", "client:" + CAM, "10.0.0.65", "10.0.0.26", 30_000.0, "RTSP", True),
                   ("guest:pve2:101", "unifi:" + UDM, "10.0.0.65", "10.0.0.1", 9_000.0, "TLS", True)]
        res, _, _ = self.run_world(w)
        pairs = self.pairs(res)
        p = pairs[("sys:pve1", "sys:pve2")]        # stable order: sorted system ids
        self.assertEqual(p["bps"], 450_000.0)
        self.assertNotIn("a_to_b_bps", p)
        self.assertNotIn("b_to_a_bps", p)
        self.assertEqual((p["layer"], p["partial"], p["kind"], p["src"], p["links"]), ("flow", True, "storage", ["flow"], 2))
        self.assertEqual(pairs[("sys:home", "sys:pve2")]["kind"], "media")
        # a flow into the core is context in the trunk pair's top, not added to it
        trunk = pairs[("sys:core", "sys:pve2")]
        self.assertEqual(trunk["bps"], (50_000 + 1_000_000) * 8.0)
        self.assertIn("flow", [t["src"] for t in trunk["top"]])
        self.assertEqual(trunk["src"], ["unifi_port"])

    def test_stable_ab_order_and_direction_swap(self):
        st = U.TrafficState()
        st.rate(("tun", "h", "wg0"), T0, (100.0, 900.0), T0)        # in 100 (remote->local), out 900
        bodies = [{"id": "x", "system": "sys:core", "label": "x"}, {"id": "y", "system": "sys:alpha", "label": "y"}]
        systems = [{"id": "sys:core"}, {"id": "sys:alpha"}]
        tun = [{"host": "h", "if": "wg0", "local": "sys:core", "remote": "sys:alpha", "local_ip": "1", "remote_ip": "2"}]
        doc = U.traffic_doc(st, T0 + 1, bodies, systems, {}, {"1": "x", "2": "y"}, {}, tunnels=tun)
        p = doc["pairs"][0]
        self.assertEqual((p["a"], p["b"]), ("sys:alpha", "sys:core"))   # "sys:alpha" < "sys:core"
        self.assertEqual((p["a_to_b_bps"], p["b_to_a_bps"]), (100.0, 900.0))
        self.assertEqual((p["top"][0]["a"], p["top"][0]["b"]), ("y", "x"))

    def test_ewma_smooths_a_step_without_overshoot(self):
        st = U.TrafficState(tau=30.0)
        key = ("port", "m", 1)
        st.counter(key, T0, 0.0, 0.0, T0)
        rx = 0.0
        for i in range(1, 4):                                     # 1000 B/s for 3 x 20 s
            rx += 1000.0 * 20
            st.counter(key, T0 + 20 * i, rx, 0.0, T0 + 20 * i)
        self.assertAlmostEqual(st.k[key]["e"][0], 8000.0)
        rx += 10_000.0 * 20                                       # step to 10 kB/s
        st.counter(key, T0 + 80, rx, 0.0, T0 + 80)
        a = 1 - math.exp(-20 / 30.0)
        self.assertAlmostEqual(st.k[key]["e"][0], 8000.0 + a * (80_000.0 - 8000.0))
        prev = st.k[key]["e"][0]
        for i in range(5, 20):
            rx += 10_000.0 * 20
            st.counter(key, T0 + 20 * i, rx, 0.0, T0 + 20 * i)
            v = st.k[key]["e"][0]
            self.assertGreaterEqual(v, prev)
            self.assertLessEqual(v, 80_000.0 + 1e-6)
            prev = v
        self.assertAlmostEqual(prev, 80_000.0, delta=80_000.0 * math.exp(-16 * 20 / 30.0) * 1.01)
        # irregular report intervals weigh by duration: one 40 s interval == two 20 s ones
        s1, s2 = U.TrafficState(), U.TrafficState()
        for s in (s1, s2):
            s.counter(key, T0, 0.0, 0.0, T0)
            s.counter(key, T0 + 20, 20_000.0, 0.0, T0 + 20)          # 1000 B/s
        s1.counter(key, T0 + 60, 20_000.0 + 400_000.0, 0.0, T0 + 60)  # 10 kB/s for 40 s
        s2.counter(key, T0 + 40, 20_000.0 + 200_000.0, 0.0, T0 + 40)
        s2.counter(key, T0 + 60, 20_000.0 + 400_000.0, 0.0, T0 + 60)
        self.assertAlmostEqual(s1.k[key]["e"][0], s2.k[key]["e"][0], places=6)

    def test_reset_skips_and_switch_cadence_does_not_alternate(self):
        st = U.TrafficState()
        key = ("sta", "m")
        st.counter(key, T0, 5000.0, 5000.0, T0)
        st.counter(key, T0 + 10, 15000.0, 5000.0, T0 + 10)           # 1000 B/s
        st.counter(key, T0 + 20, 100.0, 50.0, T0 + 20)               # counter reset (reboot)
        self.assertAlmostEqual(st.k[key]["e"][0], 8000.0)           # no spike, no negative
        st.counter(key, T0 + 30, 10100.0, 50.0, T0 + 30)
        self.assertAlmostEqual(st.k[key]["e"][0], 8000.0)
        # a USW refreshes counters every ~20-40 s although the sampler looks every 5 s
        s = U.TrafficState()
        k2 = ("port", "usw", 13)
        c = 0.0
        s.counter(k2, T0, c, 0.0, T0)
        vals = []
        for t in range(5, 200, 5):
            if t % 35 == 0:
                c = 1000.0 * t                                        # caught up: 1000 B/s on average
            s.counter(k2, T0 + (t // 35) * 35 if t >= 35 else T0, c, 0.0, T0 + t)
            if s.k[k2]["e"] is not None:
                vals.append(s.k[k2]["e"][0])
        self.assertTrue(vals)
        self.assertTrue(all(abs(v - 8000.0) < 1e-6 for v in vals), vals)

    def test_idle_is_a_measured_zero_and_a_silent_reporter_goes_absent(self):
        st = U.TrafficState()
        key = ("port", "m", 2)
        st.counter(key, T0, 100.0, 100.0, T0)
        st.counter(key, T0 + 30, 100.0, 100.0, T0 + 30)             # flat, reporter alive, < IDLE_S
        self.assertIsNone(st.k[key]["e"])
        st.counter(key, T0 + 80, 100.0, 100.0, T0 + 80)             # flat for 80 s: measured idle
        self.assertEqual(st.k[key]["e"], [0.0, 0.0])
        snap, _, _ = st.snapshot(T0 + 81)
        self.assertIn(key, snap)
        # the reporter stops (last_seen frozen): no new samples; after HOLD it is absent
        for t in range(90, 400, 10):
            st.counter(key, T0 + 80, 100.0, 100.0, T0 + t)
        snap, _, _ = st.snapshot(T0 + 80 + U.TRAFFIC_HOLD_S["port"] + 1)
        self.assertNotIn(key, snap)

    def test_departed_client_stops_counting(self):
        w = World()
        res, st, store = self.run_world(w)
        self.assertIn(PHONE, [t["b"].split(":", 1)[1] for t in self.pairs(res)[("sys:core", "sys:home")]["top"]
                              if t["b"].startswith("mac:")])
        del w.sta[PHONE]                                          # the phone leaves
        res2, _, _ = self.run_world(w, steps=3, t0=T0 + 120, state=st, store=store)
        p = self.pairs(res2)[("sys:core", "sys:home")]
        self.assertEqual(p["b_to_a_bps"], (900_000 + 100) * 8.0)  # camera port + lamp port only
        self.assertNotIn("mac:" + PHONE, [t["b"] for t in p["top"]])

    def test_state_is_bounded(self):
        st = U.TrafficState()
        st.counter(("sta", "old"), T0, 1.0, 1.0, T0)
        st.rate(("flow", "a", "b"), T0, (5.0,), T0)
        st.attach["old"] = {"wired": False, "at": T0}
        st.counter(("sta", "new"), T0 + 1000, 1.0, 1.0, T0 + 1000)
        self.assertEqual(st.prune(T0 + 1000), 2)
        self.assertEqual(list(st.k), [("sta", "new")])
        self.assertEqual(st.attach, {})
        for i in range(6100):
            st.rate(("flow", str(i), "x"), T0 + 1000, (1.0,), T0 + 1000 + i * 1e-3)
        st.prune(T0 + 1010)
        self.assertLessEqual(len(st.k), 6000)

    def test_silent_switch_drops_its_pairs(self):
        w = World()
        res, st, store = self.run_world(w)
        self.assertIn(("sys:core", "sys:pve2"), self.pairs(res))
        w.frozen.add(USW)                                         # USW stops reporting
        res2, _, _ = self.run_world(w, steps=12, t0=T0 + 120, state=st, store=store)
        pairs = self.pairs(res2)
        self.assertNotIn(("sys:core", "sys:pve2"), pairs)  # its trunk is no longer measured
        self.assertNotIn(("sys:core", "sys:pve1"), pairs)
        self.assertIn(("sys:core", "sys:home"), pairs)             # the UDM/AP side still is

    def test_tunnels_from_snmp_and_stale_zabbix_is_absent(self):
        w = World()
        vals = lambda now: {("udm-a", "wgsts1000"): {"in": 10_950_000.0, "out": 361_000.0, "clock": now - 30, "delay": 180},
                            ("udm-branch", "wgsts1001"): {"in": 10_970_000.0, "out": 358_000.0, "clock": now - 30, "delay": 180}}
        res, _, _ = self.run_world(w, tun_values=vals)
        pairs = self.pairs(res)
        branch = pairs[("sys:branch", "sys:core")]       # pairs are ordered by system id
        self.assertEqual((branch["a_to_b_bps"], branch["b_to_a_bps"]), (10_950_000.0, 361_000.0))
        self.assertEqual((branch["kind"], branch["src"], branch["layer"]), ("vpn", ["snmp"], "interface"))
        self.assertEqual((branch["top"][0]["a"], branch["top"][0]["b"]), ("ip:10.0.3.1", "mac:" + UDM))
        sd = pairs[("sys:branch", "sys:remote")]
        self.assertEqual((sd["a_to_b_bps"], sd["b_to_a_bps"]), (358_000.0, 10_970_000.0))
        old = lambda now: {("udm-a", "wgsts1000"): {"in": 1.0, "out": 1.0, "clock": now - 3600, "delay": 180}}
        res2, _, _ = self.run_world(w, tun_values=old)
        self.assertNotIn(("sys:branch", "sys:core"), self.pairs(res2))

    def test_wan_entries(self):
        w = World()
        w.flows = [("guest:pve2:101", None, "10.0.0.65", "198.41.192.47", 90_000.0, "QUIC", False),
                   ("guest:pve2:121", None, "10.0.0.7", "40.160.141.58", 6_000.0, "WireGuard", False),
                   ("guest:pve1:113", None, "10.0.0.185", "239.255.255.250", 3_000.0, "SSDP", False)]
        res, _, _ = self.run_world(w)
        wan = {x["system"]: x for x in res["traffic"]["wan"]}
        core = wan["sys:core"]
        self.assertEqual((core["in_bps"], core["out_bps"]), (1_500_000 * 8.0, 120_000 * 8.0))
        self.assertEqual((core["via"], core["layer"], core["src"]), ("ISP", "interface", ["unifi_wan"]))
        nb = wan["sys:pve2"]
        self.assertEqual((nb["bps"], nb["partial"], nb["layer"], nb["via"]), (96_000.0, True, "flow", "Pi-hole"))
        self.assertNotIn("in_bps", nb)
        self.assertEqual([t["kind"] for t in nb["top"]], ["wan", "vpn"])
        self.assertNotIn("sys:pve1", wan)                          # multicast never counts as WAN

    def test_kinds(self):
        self.assertEqual(U._flow_kind("PostgreSQL"), "lan")         # not GRE
        self.assertEqual(U._flow_kind("NFS"), "storage")
        self.assertEqual(U._flow_kind("RTSP"), "media")
        self.assertEqual(U._flow_kind("WireGuard"), "vpn")
        self.assertEqual(U._flow_kind("TLS", {"label": "proxmox-backup-server", "class": "guest_lxc"}), "backup")
        self.assertEqual(U._dominant_kind([{"kind": "media", "bps": 70.0}, {"kind": "lan", "bps": 30.0}]), "media")
        self.assertEqual(U._dominant_kind([{"kind": "media", "bps": 50.0}, {"kind": "lan", "bps": 50.0}]), "mixed")
        self.assertEqual(U._dominant_kind([{"kind": "vpn", "bps": 0.0}]), "vpn")
        for k in ("lan", "storage", "backup", "wan", "vpn", "media", "mixed"):
            self.assertIn(k, ("lan", "storage", "backup", "wan", "vpn", "media", "mixed"))

    def test_contract_shape(self):
        w = World()
        w.flows = [("pve:pve1", "pve:pve2", "10.0.0.38", "10.0.0.238", 400_000.0, "NFS", True)]
        vals = lambda now: {("udm-a", "wgsts1000"): {"in": 5.0e6, "out": 1.0e5, "clock": now - 10, "delay": 180}}
        res, _, _ = self.run_world(w, tun_values=vals)
        t = res["traffic"]
        self.assertEqual(set(t) - {"sources"}, {"ts", "window_s", "pairs", "wan"})
        sys_ids = {s["id"] for s in res["systems"]}
        body_ids = {b["id"] for b in res["bodies"]}
        keys = [(p["a"], p["b"]) for p in t["pairs"]]
        self.assertEqual(keys, sorted(keys))
        for p in t["pairs"]:
            self.assertLess(p["a"], p["b"])
            self.assertIn(p["a"], sys_ids)
            self.assertIn(p["b"], sys_ids)
            self.assertIsInstance(p["bps"], float)
            self.assertGreaterEqual(p["bps"], 0.0)
            self.assertIn(p["kind"], ("lan", "storage", "backup", "wan", "vpn", "media", "mixed"))
            self.assertEqual("a_to_b_bps" in p, "b_to_a_bps" in p)
            if "a_to_b_bps" in p:
                self.assertAlmostEqual(p["a_to_b_bps"] + p["b_to_a_bps"], p["bps"], delta=0.2)
            self.assertLessEqual(len(p["top"]), U.TRAFFIC_TOP_N)
            for c in p["top"]:
                for k in ("a", "b", "bps", "kind", "label", "src"):
                    self.assertIn(k, c)
                for bid in (c["a"], c["b"]):
                    self.assertTrue(bid is None or bid in body_ids, bid)
        json.dumps(res)


class TestZabbixFeed(unittest.TestCase):
    def fake(self, items_exist=True, login_ok=True):
        calls = []
        state = {"session": "tok1"}

        def post(url, payload, headers):
            m, p = payload["method"], payload["params"]
            calls.append((m, headers.get("Authorization")))
            if m == "user.login":
                if not login_ok:
                    return {"error": {"message": "Incorrect user name or password or account is temporarily blocked."}}
                return {"result": state["session"]}
            if headers.get("Authorization") != "Bearer " + state["session"]:
                return {"error": {"message": "Session terminated, re-login, please."}}
            if m == "host.get" and "groupids" in p:
                return {"result": [{"hostid": "9", "interfaces": [{"ip": "10.0.0.55"}, {"ip": "127.0.0.1"}]}]}
            if m == "host.get":
                return {"result": [{"hostid": "1", "host": "udm-a"}, {"hostid": "2", "host": "udm-branch"}]}
            if m == "hostgroup.get":
                return {"result": [{"groupid": "60"}]}
            if m == "item.get" and "hostids" in p:
                if not items_exist:
                    return {"result": []}
                return {"result": [
                    {"itemid": "11", "hostid": "1", "name": "Interface wgsts1000(): Bits received", "key_": "net.if.in[ifInOctets.38]", "delay": "3m"},
                    {"itemid": "12", "hostid": "1", "name": "Interface wgsts1000(): Bits sent", "key_": "net.if.out[ifOutOctets.38]", "delay": "3m"},
                    {"itemid": "13", "hostid": "1", "name": "Interface wgsts1000(): Inbound packets discarded", "key_": "net.if.in.discards[ifInDiscards.38]", "delay": "3m"},
                    {"itemid": "21", "hostid": "2", "name": "Interface wgsts1001(): Bits received", "key_": "net.if.in[ifInOctets.27]", "delay": "3m"},
                    {"itemid": "22", "hostid": "2", "name": "Interface wgsts1001(): Bits sent", "key_": "net.if.out[ifOutOctets.27]", "delay": "180s"}]}
            if m == "item.get":
                return {"result": [{"itemid": "11", "lastvalue": "10951048", "lastclock": str(int(T0) - 60)},
                                   {"itemid": "12", "lastvalue": "361424", "lastclock": str(int(T0) - 60)},
                                   {"itemid": "21", "lastvalue": "10967704", "lastclock": str(int(T0) - 30)},
                                   {"itemid": "22", "lastvalue": "358736", "lastclock": str(int(T0) - 30)}]}
            raise AssertionError(m)
        return post, calls, state

    def test_poll_resolves_by_interface_name_and_reuses_one_session(self):
        post, calls, state = self.fake()
        z = U.ZabbixFeed("http://z", "u", "p", post=post)
        z.poll(T0, TUN)
        v = z.tunnel_values()
        self.assertEqual(v[("udm-a", "wgsts1000")]["in"], 10951048.0)
        self.assertEqual(v[("udm-a", "wgsts1000")]["out"], 361424.0)
        self.assertEqual(v[("udm-branch", "wgsts1001")]["delay"], 180.0)
        self.assertEqual(z.lab_set(T0), {"10.0.0.55"})
        z.poll(T0 + 60, TUN)
        self.assertEqual([m for m, _ in calls].count("user.login"), 1)
        writes = [m for m, _ in calls if not (m.endswith(".get") or m == "user.login")]
        self.assertEqual(writes, [])                             # read-only
        state["session"] = "tok2"                                 # server expired the session
        z.poll(T0 + 120, TUN)
        self.assertEqual([m for m, _ in calls].count("user.login"), 2)

    def test_rejected_login_backs_off(self):
        post, calls, _ = self.fake(login_ok=False)
        z = U.ZabbixFeed("http://z", "u", "p", post=post)
        with self.assertRaises(Exception):
            z.poll(T0, TUN)
        for i in range(1, 10):
            with self.assertRaises(Exception):
                z.poll(T0 + 60 * i, TUN)
        self.assertEqual([m for m, _ in calls].count("user.login"), 1)  # never hammers a shared account
        self.assertEqual(z.tunnel_values(), {})

    def test_lab_bodies_are_flagged(self):
        topo = topo_fixture(extra_clients=[("00:5e:07:b3:68:3f", "10.0.0.55", "Juniper EX2200", "network")])
        obs = U.observe(topo, all_fixture(), now=T0)
        d = tempfile.mkdtemp()
        try:
            res = U.build(obs, U.Store(os.path.join(d, "s.json")), now=T0, topo=topo, lab_ips={"10.0.0.55"}, names={})
        finally:
            shutil.rmtree(d, ignore_errors=True)
        ids = {b["id"]: b for b in res["bodies"]}
        self.assertTrue(ids["mac:00:5e:07:b3:68:3f"]["lab"])
        self.assertEqual([b["id"] for b in res["bodies"] if b.get("lab")], ["mac:00:5e:07:b3:68:3f"])



# ---- short names (CONTRACTS section 7) ---------------------------------------------------
class TestShortNames(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        U._names_cache.update(mtime=None, map={})

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)
        U._names_cache.update(mtime=None, map={})

    def test_coordinator_examples(self):
        cases = [("Pve2 UDM", "gateway", "UDM"), ("USW Pro Max 24", "switch", "USW 24"),
                 ("Juniper EX2200", "switch", "Juniper"), ("Cisco IOS switch", "switch", "Cisco"),
                 ("Nokia switch", "switch", "Nokia"), ("ADVA FSP 150", "switch", "ADVA"),
                 ("TP-Link Deco Node 3", "network_device", "Deco 3"), ("U7 Pro", "ap", "U7 Pro"),
                 ("homeassistant", "guest_vm", "Home Assistant"), ("plex", "guest_lxc", "Plex"),
                 ("udm-pro-se-Branch", "network_device", "UDM Branch"), ("Switch on UDM port 7", "switch", "UDM p7 switch"),
                 ("idrac-22T4R52", "network_device", "iDRAC"), ("Camera NVR (remote)", "storage", "Camera NVR"),
                 ("Samsung TV", "tv_av", "Samsung TV")]
        for label, cls, want in cases:
            self.assertEqual(U.short_name(label, cls), want, label)

    def test_hostname_and_device_noise(self):
        cases = [("mail.pve2.net", "Mail"), ("arr-stack-ct128", "arr-stack"), ("grafana-v2", "Grafana"),
                 ("plex-lxc", "Plex"), ("myapp-1.2.3", "myapp"), ("acme-orchestrator", "orchestrator"),
                 ("pve-scripts-local", "pve-scripts"), ("proxmox-backup-server", "PBS"), ("P1 Pro-8CE9", "P1 Pro"),
                 ("Elgato Key Light MK.2 B045", "Key Light"), ("Server Room Govee H6076", "Server Room"),
                 ("Google-Home-Mini", "Home Mini"), ("RokuStreamingStick", "Roku Stick"), ("zabbix-proxy", "zabbix-proxy"),
                 ("unifi-controller", "unifi-ctl")]
        for label, want in cases:
            self.assertEqual(U.short_name(label, "unknown"), want, label)
        # a vendor-first label that is NOT network gear keeps its vendor
        self.assertEqual(U.short_name("Cisco Webex Desk", "computer"), "Cisco Webex")

    def test_ip_only_and_meaningless_names_get_none(self):
        for label in ("10.0.2.105", "10.0.0.1", "fe80::1", "aa:bb:cc:dd:ee:ff", "", None, "localhost", "  "):
            self.assertIsNone(U.short_name(label, "unknown"), label)

    def test_every_short_fits_and_is_deterministic(self):
        labels = ["averyveryverylonghostnamewithoutseparators", "Some Very Long Device Name Here",
                  "a-b-c-d-e-f-g-h-i-j-k-l-m", "Living Room Samsung QN90B Television", "x" * 40,
                  "security-monitor", "game-wings", "mock-network-lab", "TP-Link Deco Node 3"]
        for lb in labels:
            s = U.short_name(lb, "unknown")
            self.assertTrue(s and len(s) <= U.SHORT_MAX, (lb, s))
            self.assertEqual(s, U.short_name(lb, "unknown"))

    def _bodies(self):
        return [{"id": "mac:0a:5e:0e:2b:95:82", "label": "iPhone", "class": "phone", "system": "sys:home"},
                {"id": "mac:0e:5e:0f:e4:bf:36", "label": "iPhone", "class": "phone", "system": "sys:home"},
                {"id": "mac:0c:5e:10:96:a8:00", "label": "Windows PC", "class": "computer", "system": "sys:home"},
                {"id": "mac:0c:5e:10:96:a8:01", "label": "Windows PC", "class": "computer", "system": "sys:home"},
                {"id": "mac:0c:5e:10:96:a8:02", "label": "Windows PC", "class": "computer", "system": "sys:home"},
                {"id": "mac:08:5e:0b:99:83:9a", "label": "Cisco IOS switch", "class": "switch", "system": "sys:core"},
                {"id": "ip:10.0.0.90", "label": "Cisco (remote)", "class": "network_device", "system": "sys:core"},
                {"id": "mac:11:00:00:00:00:01", "label": "iPhone", "class": "phone", "system": "sys:remote"},
                {"id": "ip:10.0.2.10", "label": "10.0.2.10", "class": "unknown", "system": "sys:remote"}]

    def test_collisions_inside_a_system_only(self):
        bodies = self._bodies()
        U.apply_shorts(bodies, [], {})
        s = {b["id"]: b.get("short") for b in bodies}
        self.assertEqual((s["mac:0a:5e:0e:2b:95:82"], s["mac:0e:5e:0f:e4:bf:36"]), ("iPhone 82", "iPhone 36"))
        self.assertEqual(sorted(s[k] for k in s if k.startswith("mac:0c:5e:10")), ["Windows PC 00", "Windows PC 01", "Windows PC 02"])
        self.assertEqual((s["mac:08:5e:0b:99:83:9a"], s["ip:10.0.0.90"]), ("Cisco IOS", "Cisco remote"))
        self.assertEqual(s["mac:11:00:00:00:00:01"], "iPhone")         # alone in its system
        self.assertIsNone(s["ip:10.0.2.10"])
        self.assertNotIn("short", bodies[-1])
        for b in bodies:
            if b.get("short"):
                self.assertLessEqual(len(b["short"]), U.SHORT_MAX)
        # order-independent: the suffix belongs to the device
        import random
        for seed in range(5):
            shuffled = self._bodies()
            random.Random(seed).shuffle(shuffled)
            U.apply_shorts(shuffled, [], {})
            self.assertEqual({b["id"]: b.get("short") for b in shuffled}, s)

    def test_overrides_file(self):
        p = os.path.join(self.d, "names.json")
        with open(p, "w") as f:
            json.dump({"mac:0a:5e:0e:2b:95:82": "the operator's phone", "mac:0e:5e:0f:e4:bf:36": None,
                       "mac:0c:5e:10:96:a8:00": "Windows PC", "sys:pve1": "GPU HOST", "x": 5}, f)
        names = U.load_names(p)
        self.assertNotIn("x", names)
        bodies = self._bodies()
        systems = [{"id": "sys:pve1", "label": "pve1"}, {"id": "sys:home", "label": "home"}, {"id": "sys:pve3", "label": "pve3"}]
        U.apply_shorts(bodies, systems, names)
        s = {b["id"]: b.get("short") for b in bodies}
        self.assertEqual(s["mac:0a:5e:0e:2b:95:82"], "the operator's phone")
        self.assertIsNone(s["mac:0e:5e:0f:e4:bf:36"])                 # null hides it
        self.assertEqual(s["mac:0c:5e:10:96:a8:00"], "Windows PC")    # an override is never suffixed
        self.assertEqual(sorted(s[k] for k in ("mac:0c:5e:10:96:a8:01", "mac:0c:5e:10:96:a8:02")),
                         ["Windows PC 01", "Windows PC 02"])
        self.assertEqual([x["short"] for x in systems], ["GPU HOST", "HOME", "PVE3"])
        self.assertEqual(U.load_names(os.path.join(self.d, "missing.json")), {})
        with open(p, "w") as f:
            f.write("{broken")
        self.assertEqual(U.load_names(p), {})

    def test_build_sets_short_on_bodies_and_systems(self):
        topo = topo_fixture(extra_clients=[("f0:00:00:00:00:01", "10.0.0.11", "Google-Home-Mini", "av")])
        d = tempfile.mkdtemp()
        try:
            res = U.build(U.observe(topo, all_fixture(unknown=["10.0.0.77"]), now=T0), U.Store(os.path.join(d, "s")),
                          now=T0, topo=topo, names={})
        finally:
            shutil.rmtree(d, ignore_errors=True)
        ids = {b["id"]: b for b in res["bodies"]}
        self.assertEqual(ids["mac:f0:00:00:00:00:01"]["short"], "Home Mini")
        self.assertEqual(ids["mac:f0:00:00:00:00:01"]["label"], "Google-Home-Mini")   # label untouched
        self.assertNotIn("short", ids["ip:10.0.0.77"])
        self.assertEqual({s["id"]: s["short"] for s in res["systems"]}["sys:pve2"], "PVE2")


# ---- growth: new Proxmox nodes this weekend ---------------------------------------------------
def pve_world(nodes, port0=1):
    """nodes: [(name, ip, n_guests)]. Every node is a pvehost on its own USW port with
    bridged guests (half LXC, half VM); returns (topo, stas, gmac)."""
    topo = topo_fixture(guests=())
    topo["nodes"] = [n for n in topo["nodes"] if n["kind"] != "pvehost"]
    stas, gmac = [], {}
    for k, (name, ip, n) in enumerate(nodes):
        port = 30 + k if name not in ("pve2", "pve1") else {"pve2": 16, "pve1": 13}[name]
        topo["nodes"].append({"id": f"pve:{name}", "kind": "pvehost", "label": name, "ip": ip,
                              "parent": "unifi:" + USW, "rx": 0, "tx": 0, "measured": True, "status": "up", "meta": {}})
        nk = U.hash32(name) % 250 + 1                     # MACs follow the node, not its position
        hmac = "58:11:22:%02x:00:01" % nk
        stas.append(sta(hmac, ip, port))
        for i in range(n):
            vmid = 100 + i
            typ = "lxc" if i % 2 == 0 else "qemu"
            gm = "bc:24:11:%02x:%02x:%02x" % (nk, i // 256, i % 256)
            gip = "10.%d.%d.%d" % (nk, i // 200, i % 200 + 10)
            topo["nodes"].append({"id": f"guest:{name}:{vmid}", "kind": "guest", "label": f"{name}-svc{i:02d}", "ip": gip,
                                  "parent": f"pve:{name}", "rx": 1.0, "tx": 1.0, "measured": True, "status": "up",
                                  "meta": {"cat": "infra", "type": typ, "vmid": vmid}})
            stas.append(sta(gm, gip, port, oui="Proxmox Server Solutions GmbH"))
            gmac[(name, vmid)] = gm
    topo["links"] = [{"source": n["parent"], "target": n["id"], "bps": 8.0, "measured": True}
                     for n in topo["nodes"] if n.get("parent")]
    return topo, stas, gmac


BASE_NODES = [("pve2", "10.0.0.238", 12), ("pve1", "10.0.0.38", 6)]
PVE3 = ("pve3", "10.0.0.41", 20)
PVE4 = ("pve4", "10.0.0.42", 21)


class TestGrowth(Base):
    def grow(self, nodes, now, store=None):
        topo, stas, gmac = pve_world(nodes)
        return self.build(topo, all_fixture(), now, store=store, stas=stas, gmac=gmac)

    @staticmethod
    def pos(res):
        return {b["id"]: (b["system"], b["shell"], b["slot"]) for b in res["bodies"]}

    def test_new_nodes_append_galaxies_and_move_nothing(self):
        res1, store = self.grow(BASE_NODES, T0)
        before = self.pos(res1)
        sys1 = {s["id"]: s["slot"] for s in res1["systems"]}
        res2, _ = self.grow(BASE_NODES + [PVE3], T0 + 3600, store=store)
        p2 = self.pos(res2)
        for bid, pos in before.items():
            self.assertEqual(p2[bid], pos, bid)                       # nobody moved
        systems = {s["id"]: s for s in res2["systems"]}
        for sid, slot in sys1.items():
            self.assertEqual(systems[sid]["slot"], slot)
        s3 = systems["sys:pve3"]
        self.assertEqual((s3["slot"], s3["kind"], s3["anchor"], s3["short"]), (len(U.system_order()), "pvehost", "pve:pve3", "PVE3"))
        self.assertRegex(s3["accent"], r"^#[0-9a-f]{6}$")
        self.assertNotIn(s3["accent"], {d["accent"] for d in U.system_defs().values()})
        new = [b for b in res2["bodies"] if b["id"] not in before]
        self.assertEqual(len(new), 21)                                 # host + 20 guests
        self.assertTrue(all(b["system"] == "sys:pve3" for b in new))
        host = [b for b in new if b["class"] == "pve_host"]
        self.assertEqual(len(host), 1)
        self.assertEqual((host[0]["shell"], host[0]["slot"], host[0]["topo"]), (0, 0, "pve:pve3"))
        for cls, shell in (("guest_lxc", 3), ("guest_vm", 4)):
            slots = sorted(b["slot"] for b in new if b["class"] == cls)
            self.assertEqual(slots, list(range(10)), cls)              # dense, own shells
            self.assertTrue(all(b["shell"] == shell for b in new if b["class"] == cls))
        self.assertFalse([b for b in res2["bodies"] if b["system"] == "sys:home" and "58:11:22" in b["id"]])
        self.assertEqual(systems["sys:pve3"]["count"], 21)
        # a fourth node later: appended after the third; the third does not move
        res3, _ = self.grow(BASE_NODES + [PVE3, PVE4], T0 + 7200, store=store)
        p3 = self.pos(res3)
        for bid, pos in p2.items():
            self.assertEqual(p3[bid], pos, bid)
        sys3 = {s["id"]: s["slot"] for s in res3["systems"]}
        self.assertEqual(sys3["sys:pve4"], sys3["sys:pve3"] + 1)
        # a restart (fresh Store on the same file) reproduces every position
        res4, _ = self.grow(BASE_NODES + [PVE3, PVE4], T0 + 7300, store=U.Store(self.path))
        self.assertEqual(self.pos(res4), p3)
        self.assertEqual({s["id"]: (s["slot"], s["accent"]) for s in res4["systems"]},
                         {s["id"]: (s["slot"], s["accent"]) for s in res3["systems"]})

    def test_removed_node_holds_its_slots_for_30_days(self):
        _, store = self.grow(BASE_NODES, T0)
        res1, _ = self.grow(BASE_NODES + [PVE3], T0 + 60, store=store)
        p1 = self.pos(res1)
        pve3 = {b: p for b, p in p1.items() if p[0] == "sys:pve3"}
        self.assertEqual(len(pve3), 21)
        res2, _ = self.grow(BASE_NODES, T0 + 60 + 29 * DAY, store=store)      # node removed
        ids = self.by_id(res2)
        for bid, pos in pve3.items():
            self.assertEqual((ids[bid]["status"], self.pos(res2)[bid]), ("down", pos))
        self.assertIn("sys:pve3", {s["id"] for s in res2["systems"]})
        res3, _ = self.grow(BASE_NODES + [PVE3], T0 + 60 + 29 * DAY + 600, store=store)   # back within 30 days
        self.assertEqual({b: p for b, p in self.pos(res3).items() if p[0] == "sys:pve3"}, pve3)
        gone_at = T0 + 60 + 29 * DAY + 600 + 30 * DAY + 120
        res4, _ = self.grow(BASE_NODES + [PVE4], gone_at, store=store)         # pve3 gone for good, pve4 arrives
        ids4 = self.by_id(res4)
        self.assertFalse([b for b in pve3 if b in ids4])                       # expired after the hold
        sys4 = {s["id"]: s["slot"] for s in res4["systems"]}
        self.assertEqual(sys4["sys:pve3"], len(U.system_order()))                # galaxy slot never reused
        self.assertEqual(sys4["sys:pve4"], len(U.system_order()) + 1)
        for bid, pos in p1.items():
            if pos[0] not in ("sys:pve3",):
                self.assertEqual(self.pos(res4)[bid], pos, bid)

    def test_new_node_trunk_shows_up_as_a_pair(self):
        topo, stas, gmac = pve_world(BASE_NODES + [PVE3])
        st = U.TrafficState()
        port = next(s["sw_port"] for s in stas if s["ip"] == PVE3[1])
        for i in range(4):
            t = T0 + 20 * i
            dev = [{"mac": USW, "type": "usw", "last_seen": t,
                    "port_table": [{"port_idx": port, "up": True, "rx_bytes": 1e6 + 250_000.0 * 20 * i, "tx_bytes": 1e6 + 50_000.0 * 20 * i}]}]
            rows = [dict(s, last_seen=t) for s in stas]
            U.traffic_sample(st, t, devices=dev, stas=rows, topo=topo)
        obs = U.observe(topo, all_fixture(), now=T0 + 61, stas=stas, gmac=gmac)
        res = U.build(obs, U.Store(self.path), now=T0 + 61, topo=topo, traffic={"state": st, "tunnels": []}, names={})
        p = {(x["a"], x["b"]): x for x in res["traffic"]["pairs"]}[("sys:core", "sys:pve3")]
        self.assertEqual((p["a_to_b_bps"], p["b_to_a_bps"]), (400_000.0, 2_000_000.0))


class TestBackups(unittest.TestCase):
    """pollers backups: PBS exporter truth; an error is never 'missing'."""

    def setUp(self):
        import pollers as NP
        self.NP = NP
        NP._bk.update(good=None, good_at=0.0)
        self.saved = NP.DATA
        self.prom = mock.patch.object(NP, "PROM", "http://prometheus.invalid")   # the PBS exporter path
        self.prom.start()
        self.addCleanup(self.prom.stop)
        NP.DATA = {"guests": [{"id": 111, "name": "ollama", "node": "pve1"}, {"id": 111, "name": "searxng", "node": "pve2"},
                              {"id": 112, "name": "emby", "node": "pve1"}, {"id": 122, "name": "ubuntu", "node": "pve2"},
                              {"id": 260, "name": "trapcol-native", "node": "pve1"}]}

    def tearDown(self):
        self.NP.DATA = self.saved
        self.NP._bk.update(good=None, good_at=0.0)

    SERIES = [{"ns": "", "vm_id": "111", "vm_name": "searxng", "ts": T0 - 0.98 * DAY, "count": 15, "verify": 0},
              {"ns": "pve1", "vm_id": "111", "vm_name": "ollama", "ts": T0 - 22.9 * DAY, "count": 3, "verify": 0},
              {"ns": "", "vm_id": "112", "vm_name": "emby", "ts": T0 - 105 * DAY, "count": 1, "verify": 0},
              {"ns": "pve1", "vm_id": "112", "vm_name": "emby", "ts": T0 - 22.9 * DAY, "count": 3, "verify": T0},
              {"ns": "", "vm_id": "122", "vm_name": "ubuntu", "ts": T0 - 0.7 * DAY, "count": 15, "verify": T0}]

    def test_pve_get_raises_instead_of_reading_empty(self):
        r = mock.Mock(status_code=500, reason="Internal Server Error")
        r.json = lambda: {"data": None, "message": "pbs: error fetching datastores - 500 Can't connect to 10.0.0.7:8007\n"}
        with mock.patch.object(self.NP.requests, "get", return_value=r):
            with self.assertRaises(self.NP.PveError) as cm:
                self.NP._pve_get({"url": "https://x", "token": "t"}, "/nodes/pve1/storage/pbs/content")
        self.assertIn("Can't connect to 10.0.0.7:8007", str(cm.exception))

    def test_vmid_collisions_follow_the_node_namespace(self):
        m = self.NP.match_pbs(self.NP.DATA["guests"], self.SERIES, ["pve1", "pve2"])
        self.assertEqual(m[("pve1", 111)]["vm_name"], "ollama")
        self.assertEqual(m[("pve2", 111)]["vm_name"], "searxng")
        self.assertEqual(m[("pve1", 112)]["ns"], "pve1")          # never the stale root-namespace leftover
        self.assertNotIn(("pve1", 260), m)

    def test_summary_and_errors_never_read_as_missing(self):
        s = self.NP.summarize_backups(self.NP.DATA["guests"], self.SERIES, ["pve1", "pve2"], T0,
                                      ["pbs", "local"], [{"node": "pve1", "storage": "pbs", "error": "Can't connect"}])
        self.assertEqual((s["guests"], s["backed"], s["missing"], s["stale7"], s["unverified"]), (5, 4, 1, 2, 2))
        self.assertEqual(s["worst"][0]["name"], "trapcol-native")
        self.assertEqual(s["archives"], 37)
        self.assertEqual(s["storages"], ["local", "pbs"])
        with mock.patch.object(self.NP, "pve_nodes", return_value=[]), \
                mock.patch.object(self.NP, "_pbs_series", side_effect=RuntimeError("prometheus down")):
            first = self.NP.backups_once(T0)
        self.assertTrue(first["unknown"])
        for k in ("missing", "backed", "guests", "stale7"):
            self.assertNotIn(k, first)                            # no counts at all, so no false alarm
        with mock.patch.object(self.NP, "pve_nodes", return_value=[]), \
                mock.patch.object(self.NP, "_pbs_series", return_value=self.SERIES):
            good = self.NP.backups_once(T0 + 10)
        self.assertEqual(good["missing"], 1)
        with mock.patch.object(self.NP, "pve_nodes", return_value=[]), \
                mock.patch.object(self.NP, "_pbs_series", side_effect=RuntimeError("prometheus down")):
            later = self.NP.backups_once(T0 + 310)
        self.assertEqual((later["missing"], later["stale"], later["age_s"]), (1, True, 300))
        self.assertIn("prometheus down", later["error"])



class TestLabGuests(Base):
    """lab: true comes ONLY from the PVE tag `lab` or UNIVERSE_LAB_VMIDS, never a description."""

    def test_tags_and_override(self):
        import config as C
        self.assertEqual(C.parse_tags("community-script;Media"), ["community-script", "media"])
        self.assertEqual(C.parse_tags("a,b c"), ["a", "b", "c"])
        with mock.patch.object(C, "UNIVERSE_LAB_VMIDS", []):
            self.assertTrue(C.is_lab_guest("pve1", 977, "LAB"))
            self.assertTrue(C.is_lab_guest("pve1", 977, "noc;lab"))
            self.assertFalse(C.is_lab_guest("pve1", 977, "labs;collab"))
            self.assertFalse(C.is_lab_guest("pve1", 977, None))
        with mock.patch.object(C, "UNIVERSE_LAB_VMIDS", ["977"]):
            self.assertTrue(C.is_lab_guest("pve1", 977, None))
        with mock.patch.object(C, "UNIVERSE_LAB_VMIDS", ["pve1:978"]):
            self.assertTrue(C.is_lab_guest("pve1", "978", None))
            self.assertFalse(C.is_lab_guest("pve2", 978, None))

    def test_universe_body_lab_flag_persists_while_down(self):
        topo = topo_fixture(guests=(("pve2", 101, "pihole", "lxc"), ("pve2", 977, "scratch-tools", "lxc")))
        for n in topo["nodes"]:
            if n["id"] == "guest:pve2:977":
                n["meta"]["lab"] = True
        res, store = self.build(topo, all_fixture(), T0)
        b = self.by_id(res)
        self.assertTrue(b["vm:pve2:977"].get("lab"))
        self.assertNotIn("lab", b["vm:pve2:101"])
        self.assertEqual(res["counts"]["lab"], 1)
        # torn down: still lab while it shows as down
        topo2 = topo_fixture()
        res2, _ = self.build(topo2, all_fixture(), T0 + 60, store=store)
        b2 = self.by_id(res2)
        self.assertEqual(b2["vm:pve2:977"]["status"], "down")
        self.assertTrue(b2["vm:pve2:977"].get("lab"))
        # override by env, no tag
        with mock.patch.object(config, "UNIVERSE_LAB_VMIDS", ["pve2:101"]):
            res3, _ = self.build(topo2, all_fixture(), T0 + 120, store=store)
        self.assertTrue(self.by_id(res3)["vm:pve2:101"].get("lab"))

    def test_down_why_splits_counts(self):
        topo = topo_fixture(guests=(("pve2", 101, "pihole", "lxc"), ("pve2", 102, "win", "qemu")),
                            extra_clients=[("aa:bb:cc:00:00:01", "10.0.0.90", "laptop", "pc")])
        res, store = self.build(topo, all_fixture(), T0)
        topo2 = topo_fixture(guests=(("pve2", 102, "win", "qemu"),),
                             extra_clients=[("aa:bb:cc:00:00:01", "10.0.0.90", "laptop", "pc")])
        for n in topo2["nodes"]:
            if n["id"] == "guest:pve2:102":
                n["status"] = "down"
            if n["id"] == "client:aa:bb:cc:00:00:01":
                n["status"] = "down"
        res2, _ = self.build(topo2, all_fixture(), T0 + 3600, store=store)
        b = self.by_id(res2)
        self.assertEqual(b["vm:pve2:102"]["down_why"], "stopped")
        self.assertEqual(b["vm:pve2:101"]["down_why"], "gone")
        self.assertEqual(b["vm:pve2:101"]["gone_s"], 3600)
        self.assertEqual(b["mac:aa:bb:cc:00:00:01"]["down_why"], "offline")
        self.assertEqual(sum(res2["counts"]["down_by"].values()), res2["counts"]["down"])
        self.assertNotIn("down_why", b["vm:pve2:101"] if b["vm:pve2:101"]["status"] != "down" else {})

    def test_topology_guest_meta_carries_tag(self):
        import topology as T
        with mock.patch.object(T.config, "UNIVERSE_LAB_VMIDS", []):
            self.assertTrue(T.config.is_lab_guest("pve1", 979, "lab"))

    def test_backups_skip_lab(self):
        import pollers as NP
        guests = [{"id": 111, "name": "ollama", "node": "pve1"},
                  {"id": 977, "name": "scratch-tools", "node": "pve1", "lab": True},
                  {"id": 978, "name": "scratch-sel", "node": "pve1", "lab": True},
                  {"id": 970, "name": "testbox-gw", "node": "pve1", "lab": True}]
        series = [{"ns": "pve1", "vm_id": "111", "vm_name": "ollama", "ts": T0 - 0.2 * DAY, "count": 3, "verify": 0},
                  {"ns": "pve1", "vm_id": "970", "vm_name": "testbox-gw", "ts": T0 - 30 * DAY, "count": 1, "verify": 0}]
        s = NP.summarize_backups(guests, series, ["pve1"], T0)
        self.assertEqual((s["guests"], s["backed"], s["missing"], s["stale7"], s["unverified"]), (1, 1, 0, 0, 1))
        self.assertEqual((s["lab_skipped"], s["lab_backed"]), (3, 1))
        self.assertEqual(s["worst"], [])



class TestBackupRuns(unittest.TestCase):
    """backups.runs: the last vzdump run per node from PVE task history (read-only)."""

    LOG = ["INFO: starting new backup job: vzdump --all 1 --storage pbs --mode snapshot",
           "INFO: Starting Backup of VM 111 (lxc)", "INFO: Backup started at 2026-10-09 05:00:08",
           "INFO: Finished Backup of VM 111 (00:02:45)",
           "INFO: Starting Backup of VM 112 (lxc)",
           "ERROR: Backup of VM 112 failed - missing Datastore.Modify|Datastore.Prune",
           "INFO: Starting Backup of VM 113 (qemu)",
           "INFO: Finished Backup of VM 113 (00:00:40)",
           "INFO: Starting Backup of VM 114 (lxc)",            # killed mid-way: no end line
           "INFO: Backup job finished with errors", "TASK ERROR: job errors"]

    def setUp(self):
        import pollers as NP
        self.NP = NP
        NP._vz_logs.clear(); NP._vz_last.clear()

    def test_parse_log(self):
        p = self.NP.parse_vzdump_log(self.LOG)
        self.assertEqual((p["guests"], p["ok"], p["failed"], p["failed_ids"]), (4, 2, 2, [112, 114]))
        self.assertEqual(self.NP.parse_vzdump_log([])["guests"], 0)

    def test_summary_prefers_job_runs_and_reports_running(self):
        tasks = [{"type": "vzdump", "id": "", "upid": "U1", "starttime": T0 - 7200, "endtime": T0 - 6000, "status": "OK"},
                 {"type": "vzdump", "id": "105", "upid": "U2", "starttime": T0 - 600, "endtime": T0 - 500, "status": "OK"},
                 {"type": "vzdump", "id": "", "upid": "U0", "starttime": T0 - 86400, "endtime": T0 - 85000,
                  "status": "could not activate storage 'pbs'"}]
        logs = {"U1": {"guests": 17, "ok": 17, "failed": 0, "failed_ids": []}}
        r = self.NP.summarize_vzdump("pve1", tasks, lambda t, finished=True: logs[t["upid"]], T0)
        self.assertEqual((r["state"], r["ok"], r["guests"], r["duration_s"], r["start"]), ("ok", 17, 17, 1200, int(T0 - 7200)))
        self.assertFalse(r["manual_single"])
        self.assertNotIn("running", r)
        # a storage failure before any guest: failed, error kept, counts from the (empty) log
        r0 = self.NP.summarize_vzdump("pve1", tasks[2:], lambda t, finished=True: {"guests": 0, "ok": 0, "failed": 0, "failed_ids": []}, T0)
        self.assertEqual(r0["state"], "failed")
        self.assertIn("could not activate", r0["error"])
        # in progress
        run = [{"type": "vzdump", "id": "", "upid": "U3", "starttime": T0 - 120}] + tasks
        logs["U3"] = {"guests": 3, "ok": 2, "failed": 1, "failed_ids": [5]}
        r2 = self.NP.summarize_vzdump("pve1", run, lambda t, finished=True: logs[t["upid"]], T0)
        self.assertEqual(r2["state"], "ok")
        self.assertEqual(r2["running"], {"start": int(T0 - 120), "elapsed_s": 120, "done": 3, "ok": 2, "failed": 1})
        self.assertEqual(self.NP.summarize_vzdump("x", [], None, T0), {"node": "x", "none": True})

    def test_backups_once_attaches_runs_and_survives_errors(self):
        NP = self.NP
        prom = mock.patch.object(NP, "PROM", "http://prometheus.invalid")
        prom.start()
        self.addCleanup(prom.stop)
        nodes = [{"node": "pve1", "url": "https://g", "token": "t"}, {"node": "pve2", "url": "https://n", "token": "t"}]
        fail = set()

        def pve_get(n, path, timeout=6):
            if n["node"] in fail:
                raise NP.PveError("HTTP 403 " + path)
            if "/log" in path:
                return [{"n": i + 1, "t": l} for i, l in enumerate(TestBackupRuns.LOG)]
            if "/tasks" in path:
                return [{"type": "vzdump", "id": "", "upid": "UPID:" + n["node"], "starttime": T0 - 3600,
                         "endtime": T0 - 3000, "status": "job errors"}]
            return []
        saved = NP.DATA
        NP.DATA = {"guests": [{"id": 111, "name": "a", "node": "pve1"}]}
        try:
            with mock.patch.object(NP, "pve_nodes", return_value=nodes), mock.patch.object(NP, "_pve_get", side_effect=pve_get), \
                    mock.patch.object(NP, "_pbs_series", return_value=[{"ns": "pve1", "vm_id": "111", "vm_name": "a", "ts": T0 - 100, "count": 1}]):
                b = NP.backups_once(T0)
                self.assertEqual([(r["node"], r["state"], r["ok"], r["failed"]) for r in b["runs"]],
                                 [("pve1", "partial", 2, 2), ("pve2", "partial", 2, 2)])
                self.assertEqual(b["guests"], 1)
                fail.add("pve1")
                b2 = NP.backups_once(T0 + 300)
        finally:
            NP.DATA = saved
        g = b2["runs"][0]
        self.assertTrue(g["stale"]); self.assertEqual(g["stale_s"], 300); self.assertEqual(g["ok"], 2)
        self.assertFalse(b2["runs"][1].get("stale"))


if __name__ == "__main__":
    unittest.main()
