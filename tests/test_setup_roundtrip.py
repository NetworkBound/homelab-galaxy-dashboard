"""The wizard must report back the configuration it just stored.

``config.py`` resolves every setting through a snapshot of config.json taken at
import, and the wizard's ``/api/setup/schema`` and ``/api/setup/config`` read
through that same resolver. On a first run the snapshot is ``{}``, so after a
successful save the wizard went on answering with *blank* fields — and because
a blank is a real value to ``save()`` (it means "clear this"), re-posting that
view wrote the blanks back over everything, including the Proxmox token and
``DASH_API_KEY``.

Nothing exotic triggers it: save, reload the page before pressing Apply,
press Save again. Two clicks and the credentials are gone.

``save()`` now refreshes the JSON layer after writing, so what the wizard shows
is what is on disk, masked. The round-trip below is the regression: whatever
``GET /api/setup/config`` hands the browser must be safe to hand straight back.
"""
import importlib
import json
import os
import stat
import tempfile
import unittest

from _helpers import clean_env, clear_modules

TOKEN = "example-setup-token-123456"
H = {"X-Setup-Token": TOKEN}

# Obvious non-secrets, in the shapes the real fields take.
PVE_TOKEN = "dashboard@pve!readonly=example-0000-1111-2222-333333333333"
ZBX_PASS = "example-zabbix-password"
DASH_KEY = "example-dashboard-key-0000000000000001"

PAYLOAD = {
    "pve": [{"name": "pve1", "url": "https://10.0.0.10:8006", "token": PVE_TOKEN}],
    "zabbix": {"url": "http://10.0.0.20/api_jsonrpc.php", "user": "Admin", "pass": ZBX_PASS},
    "access": {"api_key": DASH_KEY},
}


class SetupRoundTrip(unittest.TestCase):
    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        self.cfg = os.path.join(self.td.name, "config.json")
        os.environ.update({"CONFIG_FILE": self.cfg, "DATA_DIR": self.td.name,
                           "ENABLE_GPU": "false", "SETUP_TOKEN": TOKEN, "SETUP_UI": "true"})
        self.client = importlib.import_module("app").app.test_client()

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()

    def stored(self):
        with open(self.cfg) as fh:
            return json.load(fh)

    def save(self, body):
        r = self.client.post("/api/setup/config", headers=H, json=body)
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:300])
        return r.get_json()

    # -- the bug ------------------------------------------------------------
    def test_saving_the_view_the_wizard_just_returned_keeps_every_secret(self):
        self.save(PAYLOAD)
        view = self.client.get("/api/setup/config", headers=H).get_json()

        # What the browser is shown must describe what is stored, not a blank form.
        self.assertEqual(len(view["pve"]), 1, "the node just saved is missing from the wizard's own view")
        self.assertEqual(view["pve"][0]["url"], "https://10.0.0.10:8006")

        self.save(view)                                   # the reload-then-save round-trip
        after = self.stored()
        self.assertEqual(after["pve"][0]["token"], PVE_TOKEN, "the Proxmox token was wiped")
        self.assertEqual(after["zabbix"]["pass"], ZBX_PASS, "the Zabbix password was wiped")
        self.assertEqual(after["access"]["api_key"], DASH_KEY, "the dashboard key was wiped")
        self.assertEqual(after["pve"][0]["url"], "https://10.0.0.10:8006")

    def test_the_schema_also_reflects_what_was_saved(self):
        # `configured` is deliberately not checked here: it reads a module-level
        # constant that only a restart refreshes, which is the documented
        # Save-then-Apply flow. The field values are what the browser re-posts,
        # and those are what must be current.
        self.save(PAYLOAD)
        schema = self.client.get("/api/setup/schema", headers=H).get_json()
        pve = next(s for s in schema["sections"] if s["id"] == "pve")
        self.assertEqual([i["name"] for i in pve["items"]], ["pve1"])
        self.assertEqual([i["token"] for i in pve["items"]], ["••••"])
        zbx = next(s for s in schema["sections"] if s["id"] == "zabbix")
        self.assertEqual({f["key"]: f["value"] for f in zbx["fields"]}["url"],
                         "http://10.0.0.20/api_jsonrpc.php")

    # -- the masking contract these rely on ---------------------------------
    def test_a_stored_secret_is_never_handed_back_to_the_browser(self):
        self.save(PAYLOAD)
        for route in ("/api/setup/config", "/api/setup/schema"):
            blob = json.dumps(self.client.get(route, headers=H).get_json(), ensure_ascii=False)
            for secret in (PVE_TOKEN, ZBX_PASS, DASH_KEY):
                self.assertNotIn(secret, blob, f"a stored secret reached the browser via {route}")
            self.assertIn("••••", blob, f"{route} returned neither the secret nor a mask")

    def test_resubmitting_the_mask_keeps_the_secret_and_a_new_value_replaces_it(self):
        self.save(PAYLOAD)
        self.save({"zabbix": {"url": "http://10.0.0.21/api_jsonrpc.php", "user": "Admin", "pass": "••••"}})
        self.assertEqual(self.stored()["zabbix"]["pass"], ZBX_PASS)
        self.assertEqual(self.stored()["zabbix"]["url"], "http://10.0.0.21/api_jsonrpc.php")
        self.save({"zabbix": {"url": "http://10.0.0.21/api_jsonrpc.php", "user": "Admin", "pass": "new-pw"}})
        self.assertEqual(self.stored()["zabbix"]["pass"], "new-pw")

    def test_the_file_it_writes_is_0600_and_stays_0600(self):
        self.save(PAYLOAD)
        self.assertEqual(stat.S_IMODE(os.stat(self.cfg).st_mode), 0o600)
        self.save(PAYLOAD)       # the rewrite path goes through a tmp file and os.replace
        self.assertEqual(stat.S_IMODE(os.stat(self.cfg).st_mode), 0o600)
        self.assertFalse(os.path.exists(self.cfg + ".tmp"), "the 0600 temp file was left behind")


class ApplyDoesNotKillTheProcess(unittest.TestCase):
    """``/api/setup/apply`` re-executes in place; it must not lose the port.

    Werkzeug marks its listening socket inheritable so the reloader can hand
    the bound port to a child. ``os.execv`` keeps inheritable descriptors, so
    the replacement image met its own still-bound port, failed ``bind()`` with
    EADDRINUSE and exited — pressing Apply killed the dashboard. Under systemd
    ``Restart=always`` hid it; run from the README (``python3 app.py``) it
    simply died, which is how a first-time user meets the wizard.

    The full behaviour is exercised against a real server in
    tests/fresh_setup_smoke.py; here we pin the mechanism.
    """

    def test_the_re_exec_clears_inherited_descriptors_first(self):
        clear_modules()
        setup = importlib.import_module("setup")
        self.addCleanup(clear_modules)
        self.assertTrue(hasattr(setup, "_drop_inherited_fds"),
                        "apply would inherit the bound listening socket and fail to rebind")

    def test_it_clears_the_inheritable_flag_and_leaves_stdio_alone(self):
        clear_modules()
        setup = importlib.import_module("setup")
        self.addCleanup(clear_modules)
        import socket
        s = socket.socket()
        self.addCleanup(s.close)
        s.set_inheritable(True)
        self.assertTrue(s.get_inheritable())
        setup._drop_inherited_fds()
        self.assertFalse(s.get_inheritable(), "the listening socket would survive execv and hold the port")
        for fd in (1, 2):               # the journal, or the terminal, must survive the exec
            os.fstat(fd)                # raises if it was closed out from under us


class ApplyEndToEnd(unittest.TestCase):
    """Press Apply against a real server and make sure it is still there after.

    This is the one that actually caught it: every in-process test passes with
    the bug present, because ``os.execv`` only matters when there is a bound
    socket to inherit.
    """

    PORT = 18099

    def test_the_dashboard_is_still_serving_after_apply(self):
        import subprocess
        import sys
        import time
        import urllib.error
        import urllib.request

        repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        env = dict(os.environ, CONFIG_FILE=os.path.join(td.name, "config.json"), DATA_DIR=td.name,
                   LISTEN_HOST="127.0.0.1", LISTEN_PORT=str(self.PORT), ENABLE_GPU="false",
                   SETUP_TOKEN=TOKEN, SETUP_UI="true", DEMO="")
        proc = subprocess.Popen([sys.executable, "app.py"], cwd=repo, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(proc.kill)
        url = f"http://127.0.0.1:{self.PORT}"

        def up(timeout):
            end = time.time() + timeout
            while time.time() < end:
                try:
                    urllib.request.urlopen(url + "/api/config", timeout=2).read()
                    return True
                except urllib.error.HTTPError:
                    return True                 # answering at all is enough
                except Exception:
                    time.sleep(0.4)
            return False

        self.assertTrue(up(25), "the dashboard never came up")
        req = urllib.request.Request(url + "/api/setup/apply", method="POST",
                                     headers={"X-Setup-Token": TOKEN})
        urllib.request.urlopen(req, timeout=5).read()
        time.sleep(3)                           # the re-exec sleeps 0.6 s, then rebinds
        self.assertIsNone(proc.poll(), "the process exited instead of re-executing in place")
        self.assertTrue(up(20), "the dashboard did not come back after Apply")


if __name__ == "__main__":
    unittest.main()
