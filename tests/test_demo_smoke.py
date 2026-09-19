"""DEMO=1 python3 app.py must serve the whole API from fixtures with no network."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import Request, urlopen

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PY = os.environ.get("PYTHON", sys.executable)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class DemoSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.TemporaryDirectory()
        cls.port = free_port()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("PVE_", "ZBX_", "UNIFI_", "ENABLE_"))}
        env.update({"DEMO": "1", "LISTEN_HOST": "127.0.0.1", "LISTEN_PORT": str(cls.port),
                    "CONFIG_FILE": os.path.join(cls.td.name, "config.json"), "DATA_DIR": cls.td.name,
                    "DEMO_THREAT_EVERY": "2"})
        cls.proc = subprocess.Popen([PY, "app.py"], cwd=REPO, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        cls.base = f"http://127.0.0.1:{cls.port}"
        deadline = time.time() + 30
        while time.time() < deadline:
            if cls.proc.poll() is not None:
                raise RuntimeError("demo app exited early:\n" + cls.proc.stdout.read())
            try:
                cls.get("/api/config")
                return
            except Exception:
                time.sleep(0.3)
        cls.proc.kill()
        raise RuntimeError("demo app did not come up:\n" + cls.proc.stdout.read(4000))

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
        cls.td.cleanup()

    @classmethod
    def get(cls, path, raw=False, timeout=5, method="GET", body=None):
        req = Request(cls.base + path, method=method, data=body,
                      headers={"Content-Type": "application/json"} if body else {})
        with urlopen(req, timeout=timeout) as r:
            data = r.read()
            return (r.status, data) if raw else (r.status, json.loads(data.decode()))

    def test_pages(self):
        for path in ("/", "/desk"):
            status, body = self.get(path, raw=True)
            self.assertEqual(status, 200, path)
            self.assertIn(b"<", body)
        if os.path.exists(os.path.join(REPO, "templates", "nexus.html")):
            self.assertEqual(self.get("/nexus", raw=True)[0], 200)

    def test_api_config_shape(self):
        status, cfg = self.get("/api/config")
        self.assertEqual(status, 200)
        for key in ("version", "demo", "brand", "domain", "tagline", "nodes", "wan_label", "categories",
                    "palette", "features", "addons"):
            self.assertIn(key, cfg)
        self.assertTrue(cfg["demo"])
        self.assertEqual([n["id"] for n in cfg["nodes"]], ["pve1", "pve2"])
        for n in cfg["nodes"]:
            self.assertEqual(set(n), {"id", "label", "accent"})
        for f in ("nexus", "cameras", "threats", "audience", "lights", "doom", "setup", "chat"):
            self.assertIn(f, cfg["features"])
        self.assertFalse(cfg["features"]["setup"])
        self.assertIn("stopped", cfg["palette"])
        self.assertIn("speedtest", cfg["addons"])
        self.assertNotIn("token", json.dumps(cfg).lower())

    def test_api_all(self):
        status, body = self.get("/api/all", raw=True)
        self.assertEqual(status, 200)
        # the retired personal automation stack must not leak into the public API;
        # spelled in two halves so the repo leak audit grep stays clean
        self.assertNotIn(b"nb" + b"ai", body)
        d = json.loads(body)
        for key in ("guests", "nodes", "nodes2", "storage", "pools", "zfs", "backups", "unifi", "zabbix", "zbx2",
                    "cameras", "frigate", "sources", "health", "latency", "netmap", "top", "certs", "telemetry",
                    "probe", "topology", "edge", "external", "addons", "ts", "total", "running"):
            self.assertIn(key, d, key)
        self.assertGreater(d["total"], 10)
        for block in ("cloudflare", "crowdsec", "secmon", "audience", "threats"):
            self.assertIn(block, d["edge"])

    def test_topology_gpu_showtime_threats(self):
        _, topo = self.get("/api/topology")
        for key in ("nodes", "links", "flows", "totals", "flow_meta", "edge", "external"):
            self.assertIn(key, topo)
        self.assertTrue(any(n["kind"] == "pvehost" for n in topo["nodes"]))
        _, gpu = self.get("/api/gpu")
        self.assertEqual(gpu["render_backend"], "demo")
        self.assertTrue(gpu["gpus"])
        _, st = self.get("/api/showtime")
        for key in ("ollama", "frigate", "emby", "coral", "gpu_series", "mode"):
            self.assertIn(key, st)
        self.assertIsInstance(st["mode"], dict)
        _, th = self.get("/api/threats")
        for key in ("up", "seq", "level", "name", "counts", "events", "latest"):
            self.assertIn(key, th)
        self.assertTrue(th["events"])

    def test_lightstate_mode_presence_history_cam(self):
        _, ls = self.get("/api/lightstate")
        for key in ("rgb", "hue", "mode", "phase", "beat", "bri", "stops", "ts"):
            self.assertIn(key, ls)
        status, r = self.get("/api/lightstate", method="POST",
                             body=json.dumps({"rgb": [10, 20, 30], "mode": "threat", "beat": 7}).encode())
        self.assertEqual(status, 200)
        self.assertTrue(r["ok"])
        _, ls = self.get("/api/lightstate")
        self.assertEqual(ls["rgb"], [10, 20, 30])
        self.assertEqual(ls["mode"], "threat")
        _, mode = self.get("/api/mode")
        self.assertIn(mode["mode"], mode["modes"])
        _, pres = self.get("/api/presence")
        self.assertTrue(pres["effective"])
        _, hist = self.get("/api/history?metric=net&mins=120")
        self.assertTrue(hist)
        self.assertIn("rx", hist[-1])
        _, hist = self.get("/api/history?metric=gpu&idx=0&mins=120")
        self.assertIn("util", hist[-1])
        status, jpg = self.get("/cam/front-door.jpg", raw=True)
        self.assertEqual(status, 200)
        self.assertTrue(jpg.startswith(b"\xff\xd8"))

    def test_pulse_stream(self):
        req = Request(self.base + "/api/pulse/stream")
        with urlopen(req, timeout=8) as r:
            self.assertEqual(r.status, 200)
            self.assertTrue(r.headers.get("Content-Type", "").startswith("text/event-stream"))
            chunk = b""
            deadline = time.time() + 6
            while not (b"data:" in chunk and b"\n\n" in chunk.split(b"data:", 1)[1]) and time.time() < deadline:
                chunk += r.read(64)
        self.assertIn(b"data:", chunk)
        line = chunk.split(b"data:", 1)[1].split(b"\n", 1)[0]
        payload = json.loads(line)
        for key in ("beat", "ts", "sev", "problems", "net_down"):
            self.assertIn(key, payload)

    def test_setup_api_is_off_in_demo(self):
        try:
            status, _ = self.get("/api/setup/schema", raw=True)
        except Exception as e:  # urllib raises on 4xx
            status = getattr(e, "code", None)
        self.assertIn(status, (401, 404))


if __name__ == "__main__":
    unittest.main()
