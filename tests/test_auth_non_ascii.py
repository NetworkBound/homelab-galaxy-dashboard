"""A credential with a non-ASCII character must be answered, not raised on.

``hmac.compare_digest`` refuses two ``str`` arguments when either holds a
character outside ASCII — it raises ``TypeError`` rather than returning False.
Both gates in this app compared text, so:

* ``X-API-Key: ü`` from anyone at all (no credential needed, the gate runs
  before anything else) produced an unhandled exception and HTTP 500 instead of
  401. Same through ``?key=``, the session cookie, ``X-Setup-Token`` and
  ``?token=``. Five one-request ways for an unauthenticated stranger to turn
  every route into a 500 and fill the journal with tracebacks.

* Worse, and the reason this is a correctness bug and not only a hardening one:
  a ``DASH_API_KEY`` with an accent in it locked out its own owner. Presenting
  the *correct* key raised too, so every route 500ed for everybody, forever,
  with no hint as to why — the gate is the first thing that runs, so even
  ``/login`` was gone.

The fix is to compare UTF-8 bytes. These tests pin the property that matters:
the comparison is *total*. Every input is a yes or a no; none of them is a
crash.
"""
import importlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

from _helpers import clean_env, clear_modules

ASCII_KEY = "example-dashboard-key-0000000000000001"
# Ordinary passphrases that happen not to be ASCII. Nothing exotic: an accent,
# a non-Latin script, an emoji of the kind a password manager will happily
# generate.
UNICODE_KEYS = ["sommerfährtmanschön", "пример-ключа-дашборда", "example-key-🔑-0001"]
NON_ASCII_ATTEMPTS = ["ü", "é" * 38, "🔑", "ключ"]


class _Base(unittest.TestCase):
    ENV = {}

    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        os.environ.update({"CONFIG_FILE": os.path.join(self.td.name, "config.json"),
                           "DATA_DIR": self.td.name, "ENABLE_GPU": "false", "DEMO": "1"})
        os.environ.update(self.ENV)
        self.app_module = importlib.import_module("app")
        self.client = self.app_module.app.test_client()

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()


class NonAsciiCredentialIsRefusedNotRaised(_Base):
    ENV = {"DASH_API_KEY": ASCII_KEY}

    def test_a_non_ascii_header_is_a_401(self):
        for attempt in NON_ASCII_ATTEMPTS:
            with self.subTest(attempt=attempt):
                r = self.client.get("/api/all", headers={"X-API-Key": attempt})
                self.assertEqual(r.status_code, 401, f"{attempt!r} should be refused, not crash")

    def test_a_non_ascii_query_key_is_a_401(self):
        for attempt in NON_ASCII_ATTEMPTS:
            with self.subTest(attempt=attempt):
                self.assertEqual(self.client.get("/api/all", query_string={"key": attempt}).status_code, 401)

    def test_a_non_ascii_cookie_is_a_401(self):
        for attempt in NON_ASCII_ATTEMPTS:
            with self.subTest(attempt=attempt):
                self.client.set_cookie("galaxy_session", attempt)
                self.assertEqual(self.client.get("/api/all").status_code, 401)
                self.client.delete_cookie("galaxy_session")

    def test_a_non_ascii_login_attempt_is_a_401(self):
        for attempt in NON_ASCII_ATTEMPTS:
            with self.subTest(attempt=attempt):
                r = self.client.post("/login", json={"key": attempt})
                self.assertEqual(r.status_code, 401)

    def test_no_route_can_be_made_to_500_by_the_credential_alone(self):
        """The gate runs before routing, so this covers 404s and streams too."""
        for path in ("/", "/api/all", "/api/config", "/static/galaxy.js", "/login", "/no/such/path"):
            with self.subTest(path=path):
                r = self.client.get(path, headers={"X-API-Key": "ü"})
                self.assertNotEqual(r.status_code, 500, f"{path} crashed on a non-ASCII key")


class AUnicodeKeyStillLetsItsOwnerIn(unittest.TestCase):
    """The lockout. A correct key must work whatever alphabet it is written in."""

    def _client(self, key):
        clean_env(); clear_modules()
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.addCleanup(clear_modules)
        self.addCleanup(clean_env)
        os.environ.update({"CONFIG_FILE": os.path.join(self.td.name, "config.json"),
                           "DATA_DIR": self.td.name, "ENABLE_GPU": "false", "DEMO": "1",
                           "DASH_API_KEY": key})
        return importlib.import_module("app").app.test_client()

    def test_the_correct_unicode_key_authenticates(self):
        for key in UNICODE_KEYS:
            with self.subTest(key=key):
                c = self._client(key)
                # Order matters: a success hands back the session cookie, and
                # the test client keeps it. Check the refusals first.
                self.assertEqual(c.get("/api/all").status_code, 401)
                self.assertEqual(c.get("/api/all", headers={"X-API-Key": key + "x"}).status_code, 401)
                self.assertEqual(c.get("/api/all", headers={"X-API-Key": key}).status_code, 200,
                                 "the operator is locked out of their own dashboard")

    def test_login_and_the_cookie_work_with_a_unicode_key(self):
        c = self._client(UNICODE_KEYS[0])
        r = c.post("/login", json={"key": UNICODE_KEYS[0]})
        self.assertEqual(r.status_code, 200, r.get_data(as_text=True)[:200])
        self.assertEqual(c.get("/api/all").status_code, 200, "the cookie issued at /login did not work")


class TheSetupTokenGateIsTotalToo(_Base):
    ENV = {"SETUP_TOKEN": "example-setup-token-123456", "DEMO": "", "SETUP_UI": "true"}

    def test_a_non_ascii_setup_token_is_a_401(self):
        for attempt in NON_ASCII_ATTEMPTS:
            with self.subTest(attempt=attempt):
                r = self.client.get("/api/setup/schema", headers={"X-Setup-Token": attempt})
                self.assertEqual(r.status_code, 401)
                self.assertEqual(self.client.get("/api/setup/schema",
                                                 query_string={"token": attempt}).status_code, 401)

    def test_the_right_token_still_works(self):
        r = self.client.get("/api/setup/schema", headers={"X-Setup-Token": "example-setup-token-123456"})
        self.assertEqual(r.status_code, 200)


class AUnicodeSetupTokenStillOpensTheWizard(unittest.TestCase):
    def test_it(self):
        clean_env(); clear_modules()
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.addCleanup(clear_modules)
        self.addCleanup(clean_env)
        token = "wärter-für-den-assistenten"
        os.environ.update({"CONFIG_FILE": os.path.join(td.name, "config.json"), "DATA_DIR": td.name,
                           "ENABLE_GPU": "false", "SETUP_TOKEN": token, "SETUP_UI": "true"})
        c = importlib.import_module("app").app.test_client()
        self.assertEqual(c.get("/api/setup/schema", headers={"X-Setup-Token": token}).status_code, 200)
        self.assertEqual(c.get("/api/setup/schema", headers={"X-Setup-Token": token + "x"}).status_code, 401)


if __name__ == "__main__":
    unittest.main()


class AcrossRealHTTPNotTheTestClient(unittest.TestCase):
    """The test client is not the wire, and that difference hid a real bug.

    `test_the_correct_unicode_key_authenticates` above passed against code
    that locked every non-ASCII key out, because Flask's test client hands the
    view the original `str` instead of putting bytes on a socket. A real
    request does not: WSGI decodes header octets as latin-1, so a UTF-8 `ü`
    reaches the view as the two characters `Ã¼`, and encoding *that* back as
    UTF-8 produces four bytes which never match the configured two.

    So this case has to make an actual HTTP request. It is slower, and it is
    the only version of this test that can fail when the bug is present.
    """

    KEY = "sommerfährtmanschön"
    PORT = 18897

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp()
        env = dict(os.environ, DASH_API_KEY=cls.KEY, DEMO="1", LISTEN_PORT=str(cls.PORT),
                   CONFIG_FILE=os.path.join(cls._tmp, "config.json"), DATA_DIR=cls._tmp)
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        cls._proc = subprocess.Popen([sys.executable, os.path.join(root, "app.py")], env=env,
                                     cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{cls.PORT}/api/config", timeout=2)
                break
            except urllib.error.HTTPError:
                break                       # gated, which means it is up
            except Exception:
                time.sleep(0.3)
        else:
            cls.tearDownClass()
            raise unittest.SkipTest("demo server did not start")

    @classmethod
    def tearDownClass(cls):
        p = getattr(cls, "_proc", None)
        if p:
            p.terminate()
            try:
                p.wait(timeout=10)
            except Exception:
                p.kill()
        shutil.rmtree(getattr(cls, "_tmp", "") or ".", ignore_errors=True)

    def _get(self, path, headers=None):
        req = urllib.request.Request(f"http://127.0.0.1:{self.PORT}{path}", headers=headers or {})
        try:
            return urllib.request.urlopen(req, timeout=8).status
        except urllib.error.HTTPError as e:
            return e.code

    def test_the_owner_of_a_unicode_key_can_actually_get_in(self):
        self.assertEqual(self._get("/api/all", {"X-API-Key": self.KEY}), 200,
                         "the correct non-ASCII key was refused over real HTTP: owner locked out")

    def test_a_unicode_key_in_the_query_string_works(self):
        from urllib.parse import quote
        self.assertEqual(self._get("/api/all?key=" + quote(self.KEY)), 200)

    def test_wrong_and_empty_keys_are_still_refused_over_real_http(self):
        self.assertEqual(self._get("/api/all"), 401)
        self.assertEqual(self._get("/api/all", {"X-API-Key": "wrong"}), 401)
        self.assertEqual(self._get("/api/all", {"X-API-Key": self.KEY + "x"}), 401)
        self.assertEqual(self._get("/api/all", {"Cookie": "galaxy_session=deadbeef"}), 401)
