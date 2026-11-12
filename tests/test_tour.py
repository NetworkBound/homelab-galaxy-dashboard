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


def setUpModule():
    # these tests describe an estate without Kubernetes: never pick up a cluster
    # another test module registered with k8s.py
    try:
        import k8s
        k8s.REGISTRY.set_snapshots([])
    except ImportError:
        pass


def tearDownModule():
    try:
        import k8s
        k8s.REGISTRY.set_snapshots(None)
    except ImportError:
        pass

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
        body("vm:pve2:108", "game-wings", "guest_lxc", "sys:pve2", "ptero-wings", m={"vmid": 108}),
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
        "Zabbix": {"n": 1, "sev": 4, "names": ["Zabbix (VM 301) is unreachable"],
                   "top": [{"name": "Zabbix (VM 301) is unreachable", "sev": 4}]},
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
    "ollama": [{"name": "chat", "up": True, "gpu_label": "GPU 0", "vram_used_mb": 6058,
                "loaded": [{"name": "qwen2.5:14b", "vram_mb": 6058}]},
               {"name": "big", "up": True, "gpu_label": "GPU 0 + GPU 1", "vram_used_mb": 0, "loaded": []}],
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
        ("Zabbix (VM 301) is unreachable", "Zabbix", "unreachable"),
        ("game-wings (CT 201) is unreachable", "game-wings", "unreachable"),
        ("Proxmox: VM [pve2/debian-12-tmpl (qemu/9200)]: Not r", "pve2", "VM 9200 not running"),
        ("Proxmox: LXC [pve1/scratch-tools (lxc/977)]: Not running", "pve1", "CT 977 not running"),
        ("Proxmox: VM [pve1/scratch-sel]: has been restarted", "pve1", "scratch-sel restarted"),
        ("ICMP: Unavailable by ICMP ping", "office-minipc", "no ping response"),
        ("ICMP: High ICMP ping response time", "p1-3dprinter", "slow ping"),
        ("Juniper: System status is in critical state", "lab-ex2200", "status critical"),
        ("Interface 0/25(SFP+ 1): Link down", "usw-pro-max-24", "SFP+ 1 link down"),
        ("Interface nic1(): Link down", "pve2", "nic1 link down"),
        ("pve2: Too many processes running (>3000)", "pve2", "too many processes"),
        ("High CPU on ubuntu (VM 302)", "ubuntu", "high CPU"),
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


def story_rows(res):
    """Every story candidate in a /api/tour body, with where it came from."""
    out = []
    for a in res.get("aspects", []):
        out += [(a["key"], c) for c in a.get("story", [])]
    for sy in res.get("systems", []):
        out += [(sy["id"], c) for c in sy.get("story", [])]
        for cat, cs in (sy.get("cats") or {}).items():
            out += [("%s/%s" % (sy["id"], cat), c) for c in cs]
    for ln in res.get("links", []):
        out += [("%s>%s" % (ln["a"], ln["b"]), c) for c in ln.get("story", [])]
    out += [("estate", c) for c in (res.get("estate") or {}).get("story", [])]
    return out


def story_uni():
    """UNI plus what a live registry carries: system kinds/shorts (one long enough that the
    long forms of its lines do not fit), gone + lab + offline bodies, a guest named after
    someone's business, measured traffic."""
    u = copy.deepcopy(UNI)
    meta = {"sys:core": ("network", "CORE"), "sys:pve2": ("pvehost", "PRIMARY CLUSTER"),
            "sys:pve1": ("pvehost", "MINI"), "sys:home": ("clients", "HOME")}
    for sy in u["systems"]:
        sy["kind"], sy["short"] = meta[sy["id"]]
    u["systems"].append({"id": "sys:branch", "kind": "site", "short": "BRANCH", "anchor": "ext:nvr"})
    for b in u["bodies"]:
        if b["class"].startswith("guest_"):
            b["cat"] = {"vm:pve1:111": "ai"}.get(b["id"], "infra")
            if b["status"] == "up":
                b["m"].update(rx_bps=400000.0, tx_bps=200000.0)
    u["bodies"] += [
        body("vm:pve2:301", "acme-plumbing", "guest_lxc", "sys:pve2", cat="web"),
        body("vm:pve2:302", "old-guest", "guest_lxc", "sys:pve2", status="down", down_why="gone"),
        body("mac:aa:aa:aa:aa:aa:01", "old switch", "switch", "sys:core", status="down", down_why="gone"),
        body("mac:aa:aa:aa:aa:aa:02", "Deco", "network_device", "sys:core", status="down", down_why="offline"),
        body("mac:aa:aa:aa:aa:aa:03", "laptop", "computer", "sys:home", status="down", down_why="offline",
             m={"offline_h": 1.0}),
        body("mac:aa:aa:aa:aa:aa:04", "tv", "tv_av", "sys:home"),
        body("ext:nvr", "Camera NVR", "storage", "sys:branch", m={"rtt_ms": 156.0}),
        body("cam:1", "front door", "camera", "sys:branch"), body("cam:2", "driveway", "camera", "sys:branch"),
    ]
    u["traffic"] = {"ts": NOW - 5, "window_s": 30, "pairs": [
        {"a": "sys:core", "b": "sys:pve1", "bps": 30282280.5, "a_to_b_bps": 12686249.6, "b_to_a_bps": 17596030.8},
        {"a": "sys:core", "b": "sys:pve2", "bps": 23960000.0, "a_to_b_bps": 22500000.0, "b_to_a_bps": 1460000.0},
        {"a": "sys:core", "b": "sys:home", "bps": 14700000.0},
        {"a": "sys:core", "b": "sys:nowhere", "bps": 9e9},
        {"a": "sys:pve1", "b": "sys:pve2", "bps": 20.0}]}
    return u


NUM_END = re.compile(r"\d\s*$")


class Story(unittest.TestCase):
    """Candidates for the wall's story line (/api/tour aspects[].story, systems, links, estate)."""

    def setUp(self):
        self.uni = story_uni()
        self.res = T.build(copy.deepcopy(DATA), copy.deepcopy(self.uni), copy.deepcopy(SHOW), now=NOW)
        self.sys = {s["id"]: s for s in self.res.get("systems", [])}

    def texts(self, sid):
        return [c["text"] for c in self.sys[sid]["story"]]

    def test_every_candidate_keeps_the_rule(self):
        rows = story_rows(self.res)
        self.assertGreater(len(rows), 30)
        for src, c in rows:
            t = c["text"]
            self.assertEqual(set(c), {"text", "kind", "prio"}, src)
            self.assertIn(c["kind"], ("status", "rate", "count", "age"), src)
            self.assertIsInstance(c["prio"], int)
            self.assertLessEqual(len(t), 48, (src, t))
            self.assertLessEqual(T.story_px(t), 556, (src, t))
            self.assertEqual(t, t.strip())
            self.assertIsNone(T._STORY_BAD.search(t), (src, t))
            self.assertIsNone(IP.search(t), (src, t))
            self.assertIsNone(NUM_END.search(t), "a number without a unit or a noun: %r" % t)
            self.assertFalse(any(ord(ch) < 32 for ch in t))
            if c["kind"] != "status":
                self.assertRegex(t, r"\d", (src, t))
            self.assertTrue(t[0].isupper() or t[0].isdigit() or t[0] == "$", (src, t))
            self.assertNotEqual(t, t.upper(), (src, t))

    def test_aspect_has_a_story_when_its_feed_is_up_and_none_when_down(self):
        for a in self.res["aspects"]:
            if a["status"] == "unknown":
                self.assertNotIn("story", a, a["key"])
            else:
                self.assertTrue(1 <= len(a["story"]) <= 3, a["key"])
        empty = T.build({}, None, None, now=NOW)
        self.assertEqual(story_rows(empty), [])
        for k in ("systems", "links", "estate"):
            self.assertNotIn(k, empty)

    def test_rank_is_status_rate_count_age(self):
        order = {"status": 0, "rate": 1, "count": 2, "age": 3}
        for a in self.res["aspects"]:
            ks = [(order[c["kind"]], c["prio"]) for c in a.get("story", [])]
            self.assertEqual(ks, sorted(ks), a["key"])
        d = copy.deepcopy(DATA)
        d["unifi"]["wan_up"] = "error"
        st = by_key(T.build(d, self.uni, copy.deepcopy(SHOW), now=NOW))["asp:internet"]["story"]
        self.assertEqual(st[0], {"text": "Internet link is down", "kind": "status", "prio": 1})

    def test_expected_lines(self):
        a = by_key(self.res)
        self.assertEqual(a["asp:internet"]["story"][0]["text"], "15.0 Mb/s down \u00b7 1.1 Mb/s up right now")
        self.assertEqual(a["asp:cameras"]["story"][0]["text"], "5 cameras recording \u00b7 last car 1.6 h ago")
        self.assertIn("103 of 103 guests backed up overnight", [c["text"] for c in a["asp:storage"]["story"]])
        self.assertEqual(self.texts("sys:pve2"), ["5 containers and 1 VM on Primary cluster"])     # the long form is 619 px
        self.assertEqual(self.texts("sys:pve1"), ["3 containers running on Mini"])
        self.assertEqual(self.texts("sys:core")[0], "68.9 Mb/s crossing the core right now")
        self.assertEqual(self.texts("sys:home")[0], "14.7 Mb/s between Home and Core")
        self.assertEqual(self.sys["sys:pve2"]["cats"]["infra"][0]["text"],
                         "Infra on Primary cluster moving 3.0 Mb/s")
        self.assertEqual(self.sys["sys:pve2"]["cats"]["infra"][1]["text"],
                         "5 of 6 infra guests up on Primary cluster")
        self.assertNotIn("web", self.sys["sys:pve2"]["cats"])        # < 3 guests: no blk stop
        ln = self.res["links"]
        self.assertEqual([(x["a"], x["b"]) for x in ln], [("sys:core", "sys:pve1"), ("sys:core", "sys:pve2"),
                                                         ("sys:core", "sys:home")])
        self.assertEqual([c["text"] for c in ln[0]["story"]],
                         ["30.3 Mb/s between Core and Mini right now", "12.7 Mb/s Core to Mini \u00b7 17.6 Mb/s back"])
        self.assertEqual([c["text"] for c in self.res["estate"]["story"]],
                         ["68.9 Mb/s across the estate right now", "8 containers and 1 VM running on 2 hosts"])

    def test_gone_and_lab_bodies_are_not_in_any_total(self):
        self.assertIn("3 of 4 network devices up", self.texts("sys:core"))   # not the gone switch, not the lab Juniper
        blob = json.dumps(self.res.get("systems")) + json.dumps(self.res.get("estate"))
        self.assertNotIn("acme", blob)                                      # a guest's name never reaches a story
        self.assertNotIn("Deco", blob)

    def test_status_is_only_recent_infrastructure(self):
        for sid in self.sys:
            self.assertFalse([c for c in self.sys[sid]["story"] if c["kind"] == "status"], sid)
        u = copy.deepcopy(self.uni)
        for b in u["bodies"]:
            if b["id"] == "mac:0c:5e:11:37:78:83":
                b.update(status="down", down_why="offline", m={"offline_h": 0.4})
            if b["id"] == "mac:00:5e:07:b3:68:3f":          # bench gear going dark is never news
                b.update(status="down", down_why="offline", m={"offline_h": 0.4})
            if b["id"] == "vm:pve1:112":                    # offline since yesterday: old news
                b.update(status="down", down_why="offline", m={"offline_h": 30.0})
        r = {s["id"]: s for s in T.build(copy.deepcopy(DATA), u, copy.deepcopy(SHOW), now=NOW)["systems"]}
        self.assertEqual(r["sys:core"]["story"][0], {"text": "1 device offline at Core", "kind": "status", "prio": 1})
        self.assertFalse([c for c in r["sys:pve1"]["story"] if c["kind"] == "status"])

    def test_stale_traffic_makes_no_rate(self):
        u = copy.deepcopy(self.uni)
        u["traffic"]["ts"] = NOW - 3600
        r = T.build(copy.deepcopy(DATA), u, copy.deepcopy(SHOW), now=NOW)
        self.assertNotIn("links", r)
        self.assertFalse([c for s in r["systems"] for c in s["story"] if "Mb/s" in c["text"]])
        self.assertFalse([c for c in r["estate"]["story"] if c["kind"] == "rate"])

    def test_system_names(self):
        for short, want in (("PRIMARY CLUSTER", "Primary cluster"), ("GPU", "GPU"), ("PVE1", "PVE1"), ("CORE", "Core"),
                            ("Lab 2", "Lab 2"), ("BRANCH", "Branch"), ("HOME", "Home"), ("pbs", "PBS"),
                            ("SD-WAN", "SD-WAN")):
            self.assertEqual(T._sys_name({"short": short}), want)
        self.assertEqual(T._sys_name({"id": "sys:office"}), "Office")
        self.assertEqual(T._sys_name({}), "system")

    def test_story_rule(self):
        for bad in ("Did you know the lab has 3 hosts", "Seen from orbit: 3 hosts", "How many hosts?",
                    "3 hosts up!", "Gateway at 10.0.0.1 is up", "Now showing 3 hosts", "x" * 49, ""):
            self.assertFalse(T.story_ok(bad), bad)
        # one line of the wall's 560 px box at 26 px: characters alone do not decide it
        self.assertAlmostEqual(T.story_px("0123456789"), 10 * 0.65 * 26, places=3)      # tabular figures
        self.assertGreater(T.story_px("75 containers and 15 VMs running on Primary cluster"), 560)
        self.assertFalse(T.story_ok("75 containers and 15 VMs running on Primary cluster"))
        self.assertTrue(T.story_ok("90 guests running on Primary cluster"))
        self.assertEqual(T._guests_text(75, 15, "on Primary cluster")["text"], "90 guests running on Primary cluster")
        self.assertEqual(T._guests_text(15, 4, "on Mini")["text"], "15 containers and 4 VMs running on Mini")
        self.assertIsNone(T._story("Everything is fine", "count"))           # a non-status line needs a number
        self.assertIsNone(T._story("3 hosts up", "slogan"))
        self.assertEqual(T._story("  3  hosts up ", "count", 1), {"text": "3 hosts up", "kind": "count", "prio": 1})
        self.assertEqual(len(T._stories([T._story("%d hosts up" % i, "count", i) for i in range(1, 6)] * 2)), 3)

    def test_cluster_pods_are_pods_not_host_guests(self):
        u = copy.deepcopy(self.uni)
        u["systems"].append({"id": "sys:k8s-lab", "kind": "k8s", "short": "LAB-K3S"})
        u["bodies"] += [body("k8s:lab:node:a", "node-a", "server", "sys:k8s-lab"),
                        body("k8s:lab:node:b", "node-b", "server", "sys:k8s-lab", status="down", down_why="offline")]
        u["bodies"] += [body("k8s:lab:pod:%d" % i, "web-%d" % i, "guest_lxc", "sys:k8s-lab",
                             status="up" if i < 4 else "down", m={"kind": "pod"}) for i in range(5)]
        r = T.build(copy.deepcopy(DATA), u, copy.deepcopy(SHOW), now=NOW)
        k8s = {s["id"]: s for s in r["systems"]}["sys:k8s-lab"]
        self.assertEqual([c["text"] for c in k8s["story"]], ["1 of 2 nodes ready", "4 of 5 pods running on Lab-k3s"])
        # the estate line counts the Proxmox hosts' guests only, not the cluster's pods
        self.assertIn("8 containers and 1 VM running on 2 hosts", [c["text"] for c in r["estate"]["story"]])

    def test_security_finding_problem_text(self):
        self.assertEqual(T.problem_text("active CRITICAL security finding", "security-mon")[0], "critical finding")
        self.assertEqual(T.problem_text("Alcatel Timetra TiMOS: Link down", "x")[0], "link down")


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
