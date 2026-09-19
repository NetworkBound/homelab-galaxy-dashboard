import importlib
import os
import tempfile
import unittest
from unittest import mock

from _helpers import clean_env, clear_modules


class PublicSetupTest(unittest.TestCase):
    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        # keep the wizard's token file and any config.json out of the checkout
        os.environ["CONFIG_FILE"] = os.path.join(self.td.name, "config.json")
        os.environ["DATA_DIR"] = self.td.name

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()

    def configure_minimal(self):
        os.environ.update({
            "PVE_0_NAME": "pve1",
            "PVE_0_URL": "https://127.0.0.1:8006",
            "PVE_0_TOKEN": "dashboard@pve!readonly=00000000-0000-0000-0000-000000000000",
            "ENABLE_GPU": "false",
        })

    def test_metrics_db_environment_is_used_by_app(self):
        self.configure_minimal()
        expected = os.path.join(self.td.name, "history.db")
        os.environ["METRICS_DB"] = expected
        app = importlib.import_module("app")
        self.assertEqual(app.DBPATH, expected)

    def test_metrics_db_defaults_into_data_dir(self):
        self.configure_minimal()
        config = importlib.import_module("config")
        self.assertEqual(config.METRICS_DB, os.path.join(self.td.name, "metrics.db"))

    def test_remote_gpu_exporter_entries_expose_host_name(self):
        os.environ.update({
            "GPUX_0_NAME": "render-node",
            "GPUX_0_URL": "http://127.0.0.1:9835/metrics",
        })
        config = importlib.import_module("config")
        self.assertEqual(config.REMOTE_GPU_EXPORTERS[0]["host"], "render-node")

    def test_gpu_api_does_not_500_when_gpu_render_is_disabled(self):
        self.configure_minimal()
        app = importlib.import_module("app")
        client = app.app.test_client()
        resp = client.get("/api/gpu")
        self.assertEqual(resp.status_code, 200)
        body = resp.get_json()
        self.assertEqual(body["render_backend"], "disabled")
        self.assertIn("gpus", body)

    def test_ollama_model_is_configurable(self):
        self.configure_minimal()
        os.environ["OLLAMA_URL"] = "http://127.0.0.1:11434"
        os.environ["OLLAMA_MODEL"] = "llama3.2:3b"
        app = importlib.import_module("app")
        fake = mock.Mock()
        fake.json.return_value = {"response": "ok"}
        with mock.patch("app.requests.post", return_value=fake) as post:
            resp = app.app.test_client().post("/api/chat", json={"message": "hello"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.get_json()["reply"], "ok")
        self.assertEqual(post.call_args.kwargs["json"]["model"], "llama3.2:3b")

    def test_ollama_instances_are_an_indexed_list(self):
        os.environ.update({"OLLAMA_0_NAME": "chat", "OLLAMA_0_URL": "http://127.0.0.1:11434/", "OLLAMA_0_GPUS": "0,1",
                           "OLLAMA_1_NAME": "big", "OLLAMA_1_URL": "http://127.0.0.1:11435"})
        config = importlib.import_module("config")
        self.assertEqual([o["name"] for o in config.OLLAMA_INSTANCES], ["chat", "big"])
        self.assertEqual(config.OLLAMA_INSTANCES[0]["gpus"], [0, 1])
        self.assertEqual(config.OLLAMA_URL, "http://127.0.0.1:11434")   # chat relay defaults to the first instance

    def test_unconfigured_root_redirects_to_setup(self):
        os.environ["ENABLE_GPU"] = "false"
        app = importlib.import_module("app")
        resp = app.app.test_client().get("/")
        self.assertEqual(resp.status_code, 302)
        self.assertTrue(resp.headers["Location"].endswith("/setup"))

    def test_categories_merge_over_defaults(self):
        os.environ["UI_CATEGORIES"] = '{"ai": ["mybrain"], "lab": ["bench"]}'
        config = importlib.import_module("config")
        self.assertEqual(config.categorize("mybrain-01"), "ai")
        self.assertEqual(config.categorize("bench-2"), "lab")
        self.assertEqual(config.categorize("jellyfin"), "media")
        self.assertIn("lab", config.CATEGORY_LIST)


if __name__ == "__main__":
    unittest.main()
