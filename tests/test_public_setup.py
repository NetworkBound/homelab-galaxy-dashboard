import importlib
import os
import sys
import tempfile
import unittest
from unittest import mock


MODULES = ("config", "app", "pollers", "topology")


def clear_modules():
    for name in MODULES:
        sys.modules.pop(name, None)


def clean_env():
    for key in list(os.environ):
        if key.startswith(("PVE_", "GPUX_", "AISRV_", "SVC_", "FLEET_", "ZBX_", "UNIFI_", "FRIGATE", "OLLAMA", "GRAFANA", "PROM", "NETMAP", "NTOPNG", "NP_")):
            os.environ.pop(key, None)
    for key in ("LISTEN_HOST", "LISTEN_PORT", "POLL_INTERVAL", "METRICS_DB", "HISTORY_DAYS", "ENABLE_GPU", "ENABLE_GPU_RENDER", "OLLAMA_MODEL"):
        os.environ.pop(key, None)


class PublicSetupTest(unittest.TestCase):
    def setUp(self):
        clean_env()
        clear_modules()

    def tearDown(self):
        clean_env()
        clear_modules()

    def configure_minimal(self):
        os.environ.update({
            "PVE_0_NAME": "pve1",
            "PVE_0_URL": "https://127.0.0.1:8006",
            "PVE_0_TOKEN": "dashboard@pve!readonly=00000000-0000-0000-0000-000000000000",
            "ENABLE_GPU": "false",
        })

    def test_metrics_db_environment_is_used_by_app(self):
        self.configure_minimal()
        with tempfile.TemporaryDirectory() as td:
            expected = os.path.join(td, "metrics.db")
            os.environ["METRICS_DB"] = expected
            app = importlib.import_module("app")
            self.assertEqual(app.DBPATH, expected)

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


if __name__ == "__main__":
    unittest.main()
