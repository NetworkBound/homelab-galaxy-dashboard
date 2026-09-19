"""Add-on loader: isolation (a raising add-on becomes status down), enabled(), routes."""
import importlib
import os
import tempfile
import time
import unittest

from _helpers import clean_env, clear_modules
from flask import Flask


class AddonsTest(unittest.TestCase):
    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        os.environ["CONFIG_FILE"] = os.path.join(self.td.name, "config.json")
        os.environ["DATA_DIR"] = self.td.name
        self.dir = os.path.join(self.td.name, "addons")
        os.makedirs(self.dir)

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()

    def write(self, name, src):
        with open(os.path.join(self.dir, name), "w") as fh:
            fh.write(src)

    def test_isolation_and_shapes(self):
        self.write("boom.py", "TITLE='Boom'\nINTERVAL=5\ndef poll(config):\n    raise RuntimeError('kaput')\n")
        self.write("good.py", "TITLE='Good'\ndef poll(config):\n    return {'status': 'warn', 'rows': [{'k': 'a', 'v': 1, 'cls': 'warn'}, {'k': 'b', 'v': 'x', 'cls': 'nope'}]}\n"
                              "def install(app, data):\n    app.add_url_rule('/api/addons/good/raw', 'good_raw', lambda: 'raw')\n")
        self.write("off.py", "def enabled(config):\n    return False\ndef poll(config):\n    return {}\n")
        self.write("broken.py", "this is not python\n")
        self.write("_private.py", "def poll(config):\n    return {}\n")
        config = importlib.import_module("config")
        addons = importlib.import_module("addons")
        app = Flask("t")
        data = {}
        ids = addons.load(app, data, config, addons_dir=self.dir)
        self.assertEqual(ids, ["boom", "broken", "good"])
        deadline = time.time() + 5
        while time.time() < deadline and (data["addons"]["boom"]["error"] == "not polled yet"
                                          or data["addons"]["good"]["status"] != "warn"):
            time.sleep(0.05)
        boom = data["addons"]["boom"]
        self.assertEqual(boom["status"], "down")
        self.assertIn("kaput", boom["error"])
        self.assertEqual(boom["title"], "Boom")
        good = data["addons"]["good"]
        self.assertEqual(good["status"], "warn")
        self.assertEqual(good["rows"][0], {"k": "a", "v": "1", "cls": "warn"})
        self.assertNotIn("cls", good["rows"][1])        # unknown cls dropped
        self.assertEqual(data["addons"]["broken"]["status"], "down")
        self.assertIn("import failed", data["addons"]["broken"]["error"])
        self.assertNotIn("off", data["addons"])
        self.assertNotIn("_private", data["addons"])
        self.assertEqual(app.test_client().get("/api/addons/good/raw").data, b"raw")

    def test_shipped_examples_load(self):
        config = importlib.import_module("config")
        addons = importlib.import_module("addons")
        data = {}
        ids = addons.load(Flask("t"), data, config)
        self.assertIn("example_speedtest", ids)
        self.assertNotIn("example_http_json", ids)      # skipped until ADDON_HTTP_URL is set


if __name__ == "__main__":
    unittest.main()
