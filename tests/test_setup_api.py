"""Setup wizard API: token gate, schema, config save with masked secrets, 0600 file."""
import importlib
import json
import os
import stat
import tempfile
import unittest

from _helpers import clean_env, clear_modules

TOKEN = "example-setup-token-123456"


class SetupApiTest(unittest.TestCase):
    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.td.name, "config.json")
        os.environ.update({"CONFIG_FILE": self.path, "DATA_DIR": self.td.name, "SETUP_TOKEN": TOKEN, "ENABLE_GPU": "false"})
        self.app = importlib.import_module("app")
        self.client = self.app.app.test_client()

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()

    def auth(self):
        return {"X-Setup-Token": TOKEN}

    def test_gate(self):
        self.assertEqual(self.client.get("/api/setup/schema").status_code, 401)
        self.assertEqual(self.client.get("/api/setup/schema", headers={"X-Setup-Token": "wrong"}).status_code, 401)
        self.assertEqual(self.client.post("/api/setup/config", json={}).status_code, 401)
        self.assertEqual(self.client.get("/api/setup/schema", headers=self.auth()).status_code, 200)
        self.assertEqual(self.client.get("/setup").status_code, 200)   # the page itself is not gated

    def test_schema_shape(self):
        s = self.client.get("/api/setup/schema", headers=self.auth()).get_json()
        self.assertFalse(s["configured"])
        ids = [x["id"] for x in s["sections"]]
        for sid in ("ui", "pve", "zabbix", "unifi", "frigate", "ollama", "grafana", "prometheus", "ntopng", "netmap",
                    "cloudflared", "crowdsec", "akvorado", "secmon", "cloudflare", "audience", "emby", "lights",
                    "presence", "features", "advanced"):
            self.assertIn(sid, ids)
        pve = next(x for x in s["sections"] if x["id"] == "pve")
        self.assertTrue(pve["list"] and pve["test"])
        self.assertEqual([f["key"] for f in pve["item_fields"]][:3], ["name", "url", "token"])
        self.assertTrue(next(f for f in pve["item_fields"] if f["key"] == "token")["secret"])
        zbx = next(x for x in s["sections"] if x["id"] == "zabbix")
        for f in zbx["fields"]:
            for k in ("key", "env", "label", "type", "help", "required", "value", "from_env"):
                self.assertIn(k, f)

    def test_save_masks_and_preserves_secrets(self):
        body = {"pve": [{"name": "pve1", "url": "https://10.0.0.10:8006", "token": "d@pve!r=00000000-0000-0000-0000-000000000000"}],
                "zabbix": {"url": "http://10.0.0.20/zabbix/api_jsonrpc.php", "user": "dash", "pass": "s3cret-value"},
                "ui": {"brand": "LAB"},
                "advanced": {"listen_port": "8181"}}
        r = self.client.post("/api/setup/config", json=body, headers=self.auth())
        self.assertEqual(r.status_code, 200, r.get_json())
        self.assertTrue(r.get_json()["restart"])
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        with open(self.path) as fh:
            stored = json.load(fh)
        self.assertEqual(stored["zabbix"]["pass"], "s3cret-value")
        self.assertEqual(stored["advanced"]["listen_port"], 8181)      # coerced to int
        # what the wizard reads back never contains the secret
        cur = self.client.get("/api/setup/config", headers=self.auth()).get_json()
        self.assertNotIn("s3cret-value", json.dumps(cur))
        # a second save with the masked value keeps the stored secret
        r = self.client.post("/api/setup/config", headers=self.auth(),
                             json={"zabbix": {"url": "http://10.0.0.21/zabbix/api_jsonrpc.php", "user": "dash", "pass": "••••"},
                                   "pve": [{"name": "pve1", "url": "https://10.0.0.10:8006", "token": "••••"}]})
        self.assertEqual(r.status_code, 200, r.get_json())
        with open(self.path) as fh:
            stored = json.load(fh)
        self.assertEqual(stored["zabbix"]["pass"], "s3cret-value")
        self.assertEqual(stored["zabbix"]["url"], "http://10.0.0.21/zabbix/api_jsonrpc.php")
        self.assertEqual(stored["pve"][0]["token"], "d@pve!r=00000000-0000-0000-0000-000000000000")
        self.assertEqual(stored["ui"]["brand"], "LAB")                   # untouched sections survive

    def test_list_section_settings_block_saves(self):
        """A list section's *_settings block holds section-level fields, not
        rows, so it must not be validated as a list. It used to 500 with
        "'list' object is not a mapping" on every save that touched one."""
        r = self.client.post("/api/setup/config", headers=self.auth(),
                             json={"pve": [{"name": "pve1", "url": "https://10.0.0.10:8006",
                                            "token": "d@pve!r=00000000-0000-0000-0000-000000000000"}],
                                   "pve_settings": {"verify_tls": True}})
        self.assertEqual(r.status_code, 200, r.get_json())
        with open(self.path) as fh:
            stored = json.load(fh)
        self.assertEqual(stored["pve_settings"]["verify_tls"], True)
        self.assertEqual(stored["pve"][0]["name"], "pve1")

    def test_validation_errors(self):
        r = self.client.post("/api/setup/config", headers=self.auth(),
                             json={"pve": [{"name": "", "url": "10.0.0.10:8006", "token": ""}]})
        self.assertEqual(r.status_code, 400)
        self.assertIn("required", r.get_json()["error"])
        self.assertFalse(os.path.exists(self.path))

    def test_connection_test_reports_failure_not_500(self):
        r = self.client.post("/api/setup/test", headers=self.auth(),
                             json={"section": "prometheus", "values": {"url": "http://127.0.0.1:9"}})
        self.assertEqual(r.status_code, 200)
        self.assertFalse(r.get_json()["ok"])
        self.assertIn("error", r.get_json())
        r = self.client.post("/api/setup/test", headers=self.auth(), json={"section": "nope", "values": {}})
        self.assertFalse(r.get_json()["ok"])

    def test_token_file_when_unset(self):
        clear_modules()
        os.environ.pop("SETUP_TOKEN")
        app = importlib.import_module("app")
        setup = importlib.import_module("setup")
        tok = setup.get_token()
        p = os.path.join(self.td.name, "setup-token")
        self.assertTrue(os.path.exists(p))
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertEqual(app.app.test_client().get("/api/setup/schema", headers={"X-Setup-Token": tok}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
