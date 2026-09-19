"""config.py resolves environment > config.json > defaults (docs/contracts.md)."""
import importlib
import json
import os
import tempfile
import unittest

from _helpers import clean_env, clear_modules


class ConfigLayeringTest(unittest.TestCase):
    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.td.name, "config.json")
        os.environ["CONFIG_FILE"] = self.path
        os.environ["DATA_DIR"] = self.td.name

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()

    def write(self, doc):
        with open(self.path, "w") as fh:
            json.dump(doc, fh)

    def test_defaults_when_nothing_is_set(self):
        config = importlib.import_module("config")
        self.assertEqual(config.BRAND, "GALAXY")
        self.assertEqual(config.LISTEN_PORT, 8080)
        self.assertEqual(config.PVE_NODES, [])
        self.assertFalse(config.is_configured())
        self.assertTrue(config.missing_required())

    def test_json_is_used_when_env_is_absent(self):
        self.write({"pve": [{"name": "pve1", "url": "https://10.0.0.10:8006/", "token": "u@pve!t=00000000-0000-0000-0000-000000000000",
                             "accent": "#123456"}],
                    "pve_settings": {"verify_tls": True},
                    "zabbix": {"url": "http://10.0.0.20/zabbix/api_jsonrpc.php", "user": "dash", "pass": "pw"},
                    "ui": {"brand": "HOMELAB", "node_labels": {"pve1": "RACK"}},
                    "features": {"doom": False},
                    "advanced": {"listen_port": 9090}})
        config = importlib.import_module("config")
        self.assertEqual(config.PVE_NODES[0]["node"], "pve1")
        self.assertEqual(config.PVE_NODES[0]["url"], "https://10.0.0.10:8006")   # trailing slash stripped
        self.assertTrue(config.PVE_VERIFY_TLS)
        self.assertEqual(config.ZBX_USER, "dash")
        self.assertEqual(config.BRAND, "HOMELAB")
        self.assertFalse(config.ENABLE_DOOM)
        self.assertEqual(config.LISTEN_PORT, 9090)
        self.assertTrue(config.is_configured())
        self.assertEqual(config.missing_required(), [])
        nodes = config.node_entries()
        self.assertEqual(nodes, [{"id": "pve1", "label": "RACK", "accent": "#123456"}])

    def test_env_wins_over_json(self):
        self.write({"pve": [{"name": "fromjson", "url": "https://10.0.0.10:8006", "token": "x@pve!t=00000000-0000-0000-0000-000000000000"}],
                    "zabbix": {"url": "http://10.0.0.20/json", "user": "jsonuser", "pass": "jsonpass"},
                    "ui": {"brand": "JSON"},
                    "advanced": {"listen_port": 9090, "gpu": True}})
        os.environ.update({"PVE_0_NAME": "fromenv", "PVE_0_URL": "https://10.0.0.11:8006",
                           "PVE_0_TOKEN": "y@pve!t=00000000-0000-0000-0000-000000000000",
                           "ZBX_USER": "envuser", "BRAND": "ENV", "LISTEN_PORT": "8181", "ENABLE_GPU": "false"})
        config = importlib.import_module("config")
        self.assertEqual([n["node"] for n in config.PVE_NODES], ["fromenv"])
        self.assertEqual(config.ZBX_USER, "envuser")
        self.assertEqual(config.ZBX_PASS, "jsonpass")        # unset in env -> still from json
        self.assertEqual(config.BRAND, "ENV")
        self.assertEqual(config.LISTEN_PORT, 8181)
        self.assertFalse(config.ENABLE_GPU)
        self.assertTrue(config.from_env("BRAND"))
        self.assertFalse(config.from_env("ZBX_PASS"))

    def test_corrupt_json_is_ignored_not_fatal(self):
        with open(self.path, "w") as fh:
            fh.write("{not json")
        config = importlib.import_module("config")
        self.assertEqual(config.BRAND, "GALAXY")

    def test_node_accents_default_by_index(self):
        os.environ.update({"PVE_0_NAME": "a", "PVE_0_URL": "https://10.0.0.1:8006", "PVE_0_TOKEN": "t@pve!x=00000000-0000-0000-0000-000000000000",
                           "PVE_1_NAME": "b", "PVE_1_URL": "https://10.0.0.2:8006", "PVE_1_TOKEN": "t@pve!x=00000000-0000-0000-0000-000000000000",
                           "UI_NODE_ACCENTS": '{"b": "#abcdef"}'})
        config = importlib.import_module("config")
        nodes = config.node_entries(["c"])       # a discovered extra node is appended
        self.assertEqual([n["id"] for n in nodes], ["a", "b", "c"])
        self.assertEqual(nodes[0]["accent"], config.NODE_ACCENTS_DEFAULT[0])
        self.assertEqual(nodes[1]["accent"], "#abcdef")
        self.assertEqual(nodes[2]["accent"], config.NODE_ACCENTS_DEFAULT[2])


if __name__ == "__main__":
    unittest.main()
