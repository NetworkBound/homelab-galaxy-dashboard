#!/usr/bin/env python3
"""Tests for tour.py (/api/tour). stdlib unittest only, no Flask needed.

    python3 tests/test_tour.py -v
"""
import copy
import json
import os
import re
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import config  # noqa: E402

config.DOMAIN = "example.net"            # the operator's own domain: its sites may be named on screen
config.TOUR_ASPECTS, config.TOUR_ANCHORS, config.UI_FEATURED_NODE = [], {}, ""
import tour as T  # noqa: E402

NOW = 1_791_600_000.0
KEYS = ["asp:internet", "asp:security", "asp:web", "asp:wifi", "asp:storage", "asp:power",
        "asp:monitoring", "asp:ai", "asp:cameras", "asp:media"]
IP = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")


def body(bid, label, cls, system, short=None, status="up", **kw):
    b = {"id": bid, "label": label, "class": cls, "system": system, "short": short or label,
         "status": status, "m": kw.pop("m", {})}
    b.update(kw)
    return b


UNI = {
    "v": 1, "systems": [{"id": s, "kind": k} for s, k in (("sys:core", "network"), ("sys:pve2", "pvehost"),
                                                 ("sys:pve1", "pvehost"), ("sys:home", "clients"))],
    "bodies": [
        body("name:internet", "ExampleISP", "edge", None, m={"loss": 0, "inet_ms": 10.0, "isp": "ExampleISP"}),
        body("name:cloudflare", "Cloudflare", "edge", None),
        body("mac:00:5e:01:80:fc:cb", "Pve2 UDM", "gateway", "sys:core", "UDM"),
        body("mac:0c:5e:11:37:78:83", "U7 Pro", "ap", "sys:core"),
        body("mac:04:5e:12:ac:88:4c", "USW Pro Max 24", "switch", "sys:core", "USW 24"),
        body("mac:00:5e:07:b3:68:3f", "Juniper EX2200", "switch", "sys:core", "Juniper", lab=True),
        body("mac:0c:5e:13:dd:0a:70", "pve2", "pve_host", "sys:pve2"),
        body("mac:08:5e:0d:95:ff:94", "pve1", "pve_host", "sys:pve1"),
        body("vm:pve2:115", "Zabbix", "guest_vm", "sys:pve2", m={"vmid": 115}),
        body("vm:pve2:121", "PBS", "guest_lxc", "sys:pve2", m={"vmid": 121}),
        body("vm:pve2:132", "freeradius", "guest_lxc", "sys:pve2", "FreeRADIUS", m={"vmid": 132}),
        body("vm:pve2:136", "cloudflared", "guest_lxc", "sys:pve2", m={"vmid": 136}),
        body("vm:pve2:108", "pterodactyl-wings", "guest_lxc", "sys:pve2", "ptero-wings", m={"vmid": 108}),
        body("vm:pve2:9200", "debian-12-tmpl", "guest_vm", "sys:pve2", status="down",
             down_why="stopped", m={"vmid": 9200}),
        body("vm:pve1:111", "Ollama", "guest_lxc", "sys:pve1", m={"vmid": 111}),
        body("vm:pve1:112", "Emby", "guest_lxc", "sys:pve1", m={"vmid": 112}),
        body("vm:pve1:113", "Frigate", "guest_lxc", "sys:pve1", m={"vmid": 113}),
        body("vm:pve1:977", "scratch-tools", "guest_lxc", "sys:pve1", status="down", down_why="stopped",
             lab=True, m={"vmid": 977}),
    ],
}

# shaped like the live /api/all on 2026-10-09 (values trimmed, IPs kept where the live feed has them
# so the tests prove they never reach the output)
DATA = {
    "unifi": {"clients": 110, "devices": 3, "isp": "ExampleISP", "latency": 10, "rx": 11.5, "tx": 1.1,
              "wan_ip": "10.0.9.2", "wan_up": "ok", "wifi": 7},
    "telemetry": {"up": True, "ts": NOW - 20, "wan_rx_mbps": 15.01, "wan_tx_mbps": 1.12, "watts": 235.0,
                  "inlet_c": 28.0, "fan_max": 6600.0, "smart_bad": 0.0, "smart_hot": {"pve1": 34.0, "pve2": 44.0},
                  "smart_n": {"pve1": 1.0, "pve2": 33.0}, "slo_ok": 10.0, "slo_total": 12.0,
                  "cs_banned": 22234.0, "cs_by_scn": {"crowdsecurity/http-probing": 504.09, "crowdsecurity/http-crawl-non_statics": 147.03},
                  "ap_clients": {"U7 Pro": 5.0}},
    "edge": {
        "audience": {"up": True, "ts": NOW - 30, "viewers_5m": 3, "viewers_1h": 13,
                     "by_country": [{"cc": "US"}, {"cc": "MY"}, {"cc": "AU"}, {"cc": "??"}],
                     "by_host": [{"host": "127.0.0.1", "requests": 900, "uniques": 50},
                                 {"host": "customer-site.example", "requests": 400, "uniques": 30},
                                 {"host": "example.net", "requests": 205, "uniques": 12},
                                 {"host": "signals.example.net", "requests": 3, "uniques": 2}]},
        "cloudflare": {"up": True, "ts": NOW - 10, "ha_connections": 4},
        "crowdsec": {"up": True, "ts": NOW - 10, "alerts_24h": 0, "banned": 0},
        "secmon": {"up": True, "ts": NOW - 10, "threat_level": 3, "threat_name": "BLACK",
                   "last_24h": {"CRITICAL": 0, "HIGH": 11}},
    },
    "zfs": [{"name": "flashpool", "size": 43190191128576, "cap": 7.1, "state": "ONLINE", "errs": {"c": 0, "r": 0, "w": 0}},
            {"name": "rpool", "size": 9706626088960, "cap": 6.1, "state": "ONLINE", "errs": {"c": 0, "r": 0, "w": 0}}],
    "backups": {"runs": [{"start": NOW - 20 * 3600, "end": NOW - 19 * 3600, "ok": 17, "guests": 17, "failed": 0, "state": "ok"},
                         {"start": NOW - 23 * 3600, "end": NOW - 12 * 3600, "ok": 86, "guests": 86, "failed": 0, "state": "ok"}]},
    "certs": {"ts": NOW - 900, "min_days": 39.2, "warn": 0},
    "health": [{"name": "emby", "up": True, "ip": "10.0.0.121"}, {"name": "zabbix", "up": False}] +
              [{"name": "x%d" % i, "up": True} for i in range(8)],
    "zabbix": {"hosts": 122, "problems": 35, "alert_hosts": {
        "Zabbix": {"n": 1, "sev": 4, "names": ["Zabbix (VM 115) is unreachable"],
                   "top": [{"name": "Zabbix (VM 115) is unreachable", "sev": 4}]},
        "pve2": {"n": 16, "sev": 4, "names": ["Proxmox: VM [pve2/debian-12-tmpl (qemu/9200)]: Not r"],
                         "top": [{"name": "Interface nic1(): Link down", "sev": 4},
                                 {"name": "Proxmox: VM [pve2/debian-12-tmpl (qemu/9200)]: Not running", "sev": 3}]},
        "freeradius": {"n": 1, "sev": 4, "names": ["freeradius: FreeRADIUS port 1812 not responding"]},
        "lab-ex2200": {"lab": True, "n": 1, "sev": 4, "names": ["Juniper: System status is in critical state"]},
        "demo-core-b": {"n": 1, "sev": 3, "names": ["DEMO: optical RX low on 1/1/4 (synthetic)"]},
        "usw-pro-max-24": {"n": 2, "sev": 3, "names": ["Interface 0/25(SFP+ 1): Link down", "Interface 0/3(Port 3): Link down"]},
        "ollama": {"n": 1, "sev": 2, "names": ["Disk space warning on Ollama / AI services"]},
    }},
    "frigate": {"up": True, "cams": [{"name": c, "fps": 5.0} for c in ("driveway", "front_door", "patio", "server_room", "side_yard")],
                "det_ms": {"onnx": 6.7}, "rec": {"est_days": 199.6, "pct": 1.5}},
    "cameras": ["server_room", "front_door", "driveway", "side_yard", "patio"],
}

SHOW = {
    "polled": {"ollama": NOW - 2, "emby": NOW - 2, "frigate": NOW - 2, "gpu_series": NOW - 1},
    "ollama": [{"name": "chat", "up": True, "gpu_label": "3080 Ti", "vram_used_mb": 6058,
                "loaded": [{"name": "qwen2.5:14b", "vram_mb": 6058}]},
               {"name": "big", "up": True, "gpu_label": "3080 Ti + 1080 Ti", "vram_used_mb": 0, "loaded": []}],
    "emby": {"up": True, "configured": True, "count": 4,
             "sessions": [{"user": "alice"}] * 4,
             "playing": [{"user": "alice", "title": "Some Film", "type": "Movie", "transcode": True, "paused": False},
                         {"user": "guest", "title": "Channel 4 · News", "type": "TvChannel", "live": True, "paused": False}]},
    "frigate": {"up": True, "inference_ms": 5.66,
                "events": [{"label": "car", "start": NOW - 5904}, {"label": "person", "start": NOW - 12000}]},
    "gpu_series": {"gpus": [{"power": [200.0, 220.0]}, {"power": [90.0, 100.0]}]},
}


def by_key(res):
    return {a["key"]: a for a in res["aspects"]}


def facts(a):
    return {f["k"]: f for f in a["facts"]}


class Shape(unittest.TestCase):
    def setUp(self):
        self.res = T.build(copy.deepcopy(DATA), copy.deepcopy(UNI), copy.deepcopy(SHOW), now=NOW)

    def test_contract_shape(self):
        r = self.res
        self.assertEqual(r["v"], 1)
        self.assertEqual([a["key"] for a in r["aspects"]], KEYS)
        ids = {b["id"] for b in UNI["bodies"]} | {s["id"] for s in UNI["systems"]}
        for a in r["aspects"]:
            self.assertTrue(a["key"].startswith("asp:"))
            self.assertIn(a["anchor"], ids, a["key"])
            self.assertIn(a["status"], ("ok", "warn", "crit", "unknown"))
            self.assertTrue(a["after"])
            self.assertTrue(a["line"] and "\n" not in a["line"])
            self.assertTrue(1 <= len(a["facts"]) <= 4, a["key"])
            for f in a["facts"]:
                self.assertLessEqual(len(f["k"]), 12, f)
                self.assertIsInstance(f["v"], str)
                self.assertIn(f["s"], ("ok", "warn", "crit", ""))

    def test_no_ips_users_or_customer_names(self):
        blob = json.dumps(self.res)
        self.assertIsNone(IP.search(blob), IP.search(blob) and IP.search(blob).group(0))
        self.assertNotIn("customer-plumbing", blob)
        self.assertNotIn("alice", blob.lower().replace("office minipc", ""))
        self.assertNotIn("Some Film", blob)       # what someone is watching is personal

    def test_live_values(self):
        a = by_key(self.res)
        f = facts(a["asp:internet"])
        self.assertEqual((f["Down"]["v"], f["Up"]["v"], f["Latency"]["v"], f["Loss"]["v"]), ("15.0", "1.1", "10", "0"))
        f = facts(a["asp:security"])
        self.assertEqual(f["Attacks 24h"]["v"], "651")         # Prometheus, not the stale cscli export's 0
        self.assertEqual(f["Banned IPs"]["v"], "22,234")
        self.assertEqual(f["Threat"]["s"], "warn")              # backlog only: no new criticals today
        self.assertEqual(f["Tunnel"]["v"], "4 / 4")
        f = facts(a["asp:web"])
        self.assertEqual(f["Top site"]["v"], "example.net")
        self.assertEqual(f["Countries"]["v"], "3")
        f = facts(a["asp:storage"])
        self.assertTrue(f["Last backup"]["v"].endswith("· 103 / 103"))
        self.assertEqual(f["Drives"]["v"], "34 ok")
        f = facts(a["asp:power"])
        self.assertEqual((f["Server"]["v"], f["GPUs"]["v"]), ("235", "305"))
        f = facts(a["asp:ai"])
        self.assertEqual((f["Loaded"]["v"], f["VRAM"]["v"]), ("1", "5.9"))
        f = facts(a["asp:cameras"])
        self.assertEqual((f["Recording"]["v"], f["Retention"]["v"]), ("5 / 5", "~200"))
        self.assertEqual(f["Last event"]["u"], "1.6 h ago")
        f = facts(a["asp:media"])
        self.assertEqual((f["Sessions"]["v"], f["Playing"]["v"], f["Transcoding"]["v"], f["Live TV"]["v"]),
                         ("4", "2", "1", "Channel 4"))
        f = facts(a["asp:monitoring"])
        self.assertEqual(f["Problems"]["v"], "3")              # Zabbix, pve2, freeradius; not the lab
        self.assertEqual(a["asp:monitoring"]["status"], "crit")
        self.assertEqual(f["Endpoints"]["s"], "warn")


class Missing(unittest.TestCase):
    def test_everything_missing_is_unknown_not_zero(self):
        res = T.build({}, None, None, now=NOW)
        self.assertEqual([a["key"] for a in res["aspects"]], KEYS)
        for a in res["aspects"]:
            self.assertEqual(a["status"], "unknown", a["key"])
            self.assertEqual(a["facts"], [{"k": "Feed", "v": "unavailable", "s": ""}])
            self.assertNotIn('"0"', json.dumps(a))
        self.assertEqual(res["problems"], [])

    def test_no_universe_keeps_pinned_anchor(self):
        from unittest import mock
        with mock.patch.object(T.config, "TOUR_ANCHORS", {"asp:cameras": "vm:pve1:113"}):
            res = T.build({}, None, None, now=NOW)
        self.assertEqual(by_key(res)["asp:cameras"]["anchor"], "vm:pve1:113")
        self.assertEqual(by_key(T.build({}, None, None, now=NOW))["asp:cameras"]["anchor"], "sys:core")

    def test_stale_telemetry_is_absent(self):
        d = copy.deepcopy(DATA)
        d["telemetry"]["ts"] = NOW - 3600
        a = by_key(T.build(d, UNI, None, now=NOW))
        self.assertEqual(a["asp:power"]["status"], "unknown")      # no pve1 series either
        self.assertNotIn("Drives", facts(a["asp:storage"]))
        self.assertEqual(facts(a["asp:security"])["Banned IPs"]["v"], "0")   # falls back to the cscli export

    def test_zabbix_error_is_not_zero_problems(self):
        d = copy.deepcopy(DATA)
        d["zabbix"] = {"error": "auth"}
        a = by_key(T.build(d, UNI, SHOW, now=NOW))["asp:monitoring"]
        self.assertNotIn("Problems", facts(a))
        self.assertEqual(a["line"], "Zabbix feed unavailable")

    def test_unifi_zero_latency_is_absent(self):
        d = copy.deepcopy(DATA)
        d["unifi"]["latency"] = 0
        uni = copy.deepcopy(UNI)
        uni["bodies"][0]["m"] = {}
        self.assertNotIn("Latency", facts(by_key(T.build(d, uni, None, now=NOW))["asp:internet"]))

    def test_wan_down_is_crit(self):
        d = copy.deepcopy(DATA)
        d["unifi"]["wan_up"] = "error"
        a = by_key(T.build(d, UNI, None, now=NOW))["asp:internet"]
        self.assertEqual(a["status"], "crit")
        self.assertEqual(a["line"], "Internet link down")

    def test_emby_down_and_unconfigured(self):
        s = copy.deepcopy(SHOW)
        s["emby"] = {"up": False, "configured": True, "sessions": [], "playing": []}
        d = copy.deepcopy(DATA)
        d["health"] = [{"name": "emby", "up": False}]
        a = by_key(T.build(d, UNI, s, now=NOW))["asp:media"]
        self.assertEqual(a["status"], "crit")
        s["emby"] = {"up": False, "configured": False}
        d["health"] = []
        self.assertEqual(by_key(T.build(d, UNI, s, now=NOW))["asp:media"]["status"], "unknown")

    def test_frigate_down_is_crit(self):
        d = copy.deepcopy(DATA)
        d["frigate"] = {"up": False}
        s = copy.deepcopy(SHOW)
        s["frigate"] = {"up": False}
        a = by_key(T.build(d, UNI, s, now=NOW))["asp:cameras"]
        self.assertEqual(a["status"], "crit")

    def test_broken_feed_does_not_break_tour(self):
        d = copy.deepcopy(DATA)
        d["zfs"] = "garbage"
        d["backups"] = {"runs": "garbage"}
        res = T.build(d, UNI, SHOW, now=NOW)
        self.assertEqual(len(res["aspects"]), 10)

    def test_anchor_falls_back_to_label_then_system(self):
        uni = copy.deepcopy(UNI)
        for b in uni["bodies"]:
            if b["id"] == "vm:pve1:113":
                b["id"] = "vm:pve1:213"          # Frigate moved
        self.assertEqual(by_key(T.build({}, uni, None, now=NOW))["asp:cameras"]["anchor"], "vm:pve1:213")
        uni["bodies"] = [b for b in uni["bodies"] if b["id"] not in ("vm:pve1:213",)]
        # nothing camera-like left: the featured node's galaxy (the Proxmox system listed first on a tie)
        self.assertEqual(by_key(T.build({}, uni, None, now=NOW))["asp:cameras"]["anchor"], "sys:pve2")


class ProblemText(unittest.TestCase):
    CASES = [
        ("Zabbix (VM 115) is unreachable", "Zabbix", "unreachable"),
        ("pterodactyl-wings (CT 108) is unreachable", "pterodactyl-wings", "unreachable"),
        ("Proxmox: VM [pve2/debian-12-tmpl (qemu/9200)]: Not r", "pve2", "VM 9200 not running"),
        ("Proxmox: LXC [pve1/scratch-tools (lxc/977)]: Not running", "pve1", "CT 977 not running"),
        ("Proxmox: VM [pve1/scratch-sel]: has been restarted", "pve1", "scratch-sel restarted"),
        ("ICMP: Unavailable by ICMP ping", "office-minipc", "no ping response"),
        ("ICMP: High ICMP ping response time", "p1-3dprinter", "slow ping"),
        ("Juniper: System status is in critical state", "lab-ex2200", "status critical"),
        ("Interface 0/25(SFP+ 1): Link down", "usw-pro-max-24", "SFP+ 1 link down"),
        ("Interface nic1(): Link down", "pve2", "nic1 link down"),
        ("pve2: Too many processes running (>3000)", "pve2", "too many processes"),
        ("High CPU on ubuntu (VM 122)", "ubuntu", "high CPU"),
        ("Linux: High swap space usage (less than 50% free)", "pve1", "high swap use"),
        ("freeradius: FreeRADIUS port 1812 not responding", "freeradius", "port 1812 not responding"),
        ("DEMO: CRC errors on gi1/0/48 (synthetic)", "demo-access-a", "CRC errors on gi1/0/48"),
        ("Disk space warning on Ollama / AI services", "ollama", "low disk space"),
        ("Mail: SMTP down on 10.0.0.134", "mail", "SMTP down"),
    ]

    def test_cases(self):
        for raw, host, want in self.CASES:
            self.assertEqual(T.problem_text(raw, host)[0], want, raw)

    def test_long_text_is_clipped(self):
        t = T.problem_text("Something extremely verbose happened to the replication subsystem again today", "x")[0]
        self.assertLessEqual(len(t), T.PROBLEM_MAX)
        self.assertTrue(t.endswith("…"))


class Problems(unittest.TestCase):
    def setUp(self):
        self.p = T.build(copy.deepcopy(DATA), copy.deepcopy(UNI), None, now=NOW)["problems"]
        self.by = {x["host"]: x for x in self.p}

    def test_short_hosts_and_grouping(self):
        self.assertIn("FreeRADIUS", self.by)
        self.assertIn("USW 24", self.by)
        self.assertIn("Juniper", self.by)              # lab-ex2200 -> Juniper EX2200 body
        self.assertEqual(self.by["pve2"]["text"], "nic1 link down")   # worst of 16, not the stopped template
        self.assertEqual(self.by["pve2"]["n"], 16)
        self.assertEqual(self.by["USW 24"]["text"], "SFP+ 1 link down")

    def test_order_and_lab_never_red(self):
        sev = [(x["lab"], -x["sev"]) for x in self.p]
        self.assertEqual(sev, sorted(sev))
        for x in self.p:
            if x["lab"]:
                self.assertLess(x["sev"], 4)
        self.assertTrue(self.by["demo-core-b"]["lab"])  # synthetic demo hosts count as lab

    def test_stopped_guest_not_red_without_top(self):
        d = copy.deepcopy(DATA)
        d["zabbix"]["alert_hosts"] = {"pve2": {"n": 1, "sev": 4, "names": [
            "Proxmox: VM [pve2/debian-12-tmpl (qemu/9200)]: Not r"]}}
        p = T.build(d, UNI, None, now=NOW)["problems"]
        self.assertEqual(p, [{"host": "pve2", "text": "VM 9200 not running", "sev": 3, "lab": False, "n": 1}])

    def test_lab_guest_problem_is_lab(self):
        d = copy.deepcopy(DATA)
        d["zabbix"]["alert_hosts"] = {"pve1": {"n": 1, "sev": 3, "top": [
            {"name": "Proxmox: LXC [pve1/scratch-tools (lxc/977)]: Not running", "sev": 3}]}}
        p = T.build(d, UNI, None, now=NOW)["problems"]
        self.assertTrue(p[0]["lab"])


class Install(unittest.TestCase):
    def test_route_and_cache(self):
        fake = types.ModuleType("flask")

        class Resp:
            def __init__(self, body, mimetype=None, headers=None):
                self.body, self.mimetype, self.headers = body, mimetype, headers
        fake.Response = Resp
        from unittest import mock
        patcher = mock.patch.dict(sys.modules, {"flask": fake})   # a real flask may already be imported
        patcher.start()
        self.addCleanup(patcher.stop)
        routes = {}

        class App:
            def route(self, path, **kw):
                def deco(fn):
                    routes[path] = fn
                    return fn
                return deco
        D = copy.deepcopy(DATA)
        T._cache.update(at=0.0, body=None)
        T.install(App(), D)
        r1 = routes["/api/tour"]()
        self.assertEqual(json.loads(r1.body)["v"], 1)
        D["unifi"]["wifi"] = 99
        r2 = routes["/api/tour"]()                        # inside CACHE_S: same body
        self.assertEqual(r1.body, r2.body)
        T._cache["at"] = 0.0
        r3 = routes["/api/tour"]()
        self.assertIn('"v":"99"', r3.body)


if __name__ == "__main__":
    unittest.main()
