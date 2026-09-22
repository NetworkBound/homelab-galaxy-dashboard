"""The optional DASH_API_KEY gate (auth.py): opt-in, fail-closed, everywhere.

These tests exist because of a proposed fix that was not merged: two lines on
``/api/all`` comparing ``X-API-Key`` against ``os.environ.get("DASH_API_KEY", "")``.
It was bypassable (an empty header matches an unset key), it 401ed the
dashboard's own front end (which sends no header), and it covered one route of
about twenty. Each of those is a test below, plus the backwards-compatibility
rule that matters most here: with no key configured, nothing changes.

Runs under pytest or ``python3 -m unittest discover -s tests``.
"""
import importlib
import json
import os
import re
import tempfile
import unittest

from _helpers import clean_env, clear_modules

# Obvious non-secrets. WRONG_KEY is the same length as KEY on purpose: a length
# check is not a comparison, and compare_digest leaks length by design.
KEY = "example-dashboard-key-0000000000000001"
WRONG_KEY = "example-dashboard-key-0000000000000002"

# Gated by design, but exempt from *this* gate: /login has to be reachable to be
# useful, and /setup + /api/setup/* carry their own token gate in setup.py.
EXEMPT = ("/login", "/setup")
EXEMPT_PREFIXES = ("/api/setup/",)


def concrete(rule):
    """``/cam/<name>.jpg`` -> ``/cam/x.jpg``: a URL we can actually request."""
    return re.sub(r"<[^>]+>", "x", rule.rule)


def method_for(rule):
    return "GET" if "GET" in rule.methods else ("POST" if "POST" in rule.methods else None)


def gated_rules(flask_app):
    """Every route the gate is expected to protect, straight from the app.

    Enumerated rather than listed so that a route added tomorrow is covered by
    this test tomorrow, instead of quietly falling outside a stale constant.
    """
    out = []
    for rule in flask_app.url_map.iter_rules():
        path = concrete(rule)
        if path in EXEMPT or path.startswith(EXEMPT_PREFIXES):
            continue
        if method_for(rule) is None:
            continue
        out.append(rule)
    return out


class AuthTestBase(unittest.TestCase):
    ENV = {}

    def setUp(self):
        clean_env()
        clear_modules()
        self.td = tempfile.TemporaryDirectory()
        os.environ.update({"CONFIG_FILE": os.path.join(self.td.name, "config.json"),
                           "DATA_DIR": self.td.name, "ENABLE_GPU": "false"})
        os.environ.update(self.ENV)
        self.app_module = importlib.import_module("app")
        self.auth = importlib.import_module("auth")
        self.flask_app = self.app_module.app
        self.client = self.flask_app.test_client()

    def tearDown(self):
        clean_env()
        clear_modules()
        self.td.cleanup()


class EveryRouteGatedMixin:
    """Applied to both route sets the app can serve: demo fixtures and live."""

    def test_every_route_is_gated(self):
        rules = gated_rules(self.flask_app)
        self.assertGreater(len(rules), 15, "route enumeration found almost nothing; it is broken")
        for rule in rules:
            path, method = concrete(rule), method_for(rule)
            resp = self.client.open(path, method=method)
            self.assertEqual(resp.status_code, 401, f"{method} {path} was not gated")


class KeyConfiguredTest(EveryRouteGatedMixin, AuthTestBase):
    """DEMO fixtures with a key set: the whole surface is behind it."""
    ENV = {"DEMO": "1", "DASH_API_KEY": KEY}

    def test_the_empty_header_bypass_is_rejected(self):
        # The exact shape of the rejected fix: "" != "" is False, so a gate that
        # only compares lets this through. Header, query string and cookie.
        for headers in ({"X-API-Key": ""}, {"X-API-Key": " "}, {}):
            self.assertEqual(self.client.get("/api/all", headers=headers).status_code, 401, headers)
        self.assertEqual(self.client.get("/api/all?key=").status_code, 401)
        self.client.set_cookie("galaxy_session", "", domain="localhost")
        self.assertEqual(self.client.get("/api/all").status_code, 401)

    def test_the_endpoints_the_report_named_are_among_them(self):
        # A guard on the guard: if the enumeration above ever stops seeing the
        # interesting routes, this fails instead of passing on an empty set.
        paths = {concrete(r) for r in gated_rules(self.flask_app)}
        for path in ("/", "/api/all", "/api/topology", "/api/inventory", "/api/telemetry", "/api/prom",
                     "/api/history", "/api/gpu", "/api/config", "/cam/x.jpg", "/api/threats",
                     "/api/showtime", "/api/lightstate", "/static/x"):
            self.assertIn(path, paths, path)

    def test_the_right_key_works_and_a_wrong_one_of_the_same_length_does_not(self):
        # A client per attempt: the first success drops a cookie, and a cookie
        # jar carrying a valid session would answer for the attempts after it.
        ok = self.flask_app.test_client().get("/api/all", headers={"X-API-Key": KEY})
        self.assertEqual(ok.status_code, 200)
        self.assertIn("guests", ok.get_json())
        self.assertEqual(len(WRONG_KEY), len(KEY))       # same length, so length is not what rejects it
        for bad in (WRONG_KEY, KEY + "x", KEY[:-1], KEY.upper(), " " + KEY):
            resp = self.flask_app.test_client().get("/api/all", headers={"X-API-Key": bad})
            self.assertEqual(resp.status_code, 401, bad)

    def test_a_header_request_is_handed_a_session_cookie(self):
        resp = self.client.get("/api/all", headers={"X-API-Key": KEY})
        cookie = resp.headers.get("Set-Cookie", "")
        self.assertIn("galaxy_session=", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)
        self.assertNotIn("Secure", cookie)          # plain HTTP: marking it Secure would lose the cookie
        self.assertNotIn(KEY, cookie)               # the cookie proves the key, it is not the key

    def test_the_cookie_alone_then_authenticates_the_browser(self):
        # This is the part header-only auth cannot do: the front end's bare
        # fetch()/EventSource calls send no header, only the cookie.
        self.assertEqual(self.client.get("/api/all").status_code, 401)
        self.assertEqual(self.client.get("/api/all", headers={"X-API-Key": KEY}).status_code, 200)
        self.assertEqual(self.client.get("/api/all").status_code, 200)        # cookie jar only
        self.assertEqual(self.client.get("/api/topology").status_code, 200)
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_the_login_form_is_the_human_way_in(self):
        page = self.client.get("/login")
        self.assertEqual(page.status_code, 200)
        self.assertIn(b'name="key"', page.data)
        self.assertEqual(self.client.post("/login", data={"key": WRONG_KEY}).status_code, 401)
        self.assertEqual(self.client.get("/api/all").status_code, 401)
        resp = self.client.post("/login", data={"key": KEY, "next": "/desk"})
        self.assertEqual(resp.status_code, 303)
        self.assertTrue(resp.headers["Location"].endswith("/desk"))
        self.assertIn("HttpOnly", resp.headers.get("Set-Cookie", ""))
        self.assertEqual(self.client.get("/api/all").status_code, 200)

    def test_login_does_not_bounce_off_site(self):
        resp = self.client.post("/login", data={"key": KEY, "next": "https://example.com/"})
        self.assertTrue(resp.headers["Location"].endswith("/"))
        self.assertNotIn("example.com", resp.headers["Location"])

    def test_a_browser_navigation_gets_the_form_not_a_bare_401(self):
        resp = self.client.get("/", headers={"Accept": "text/html,application/xhtml+xml"})
        self.assertEqual(resp.status_code, 401)
        self.assertIn(b'name="key"', resp.data)
        self.assertNotIn(KEY.encode(), resp.data)
        xhr = self.client.get("/api/all", headers={"Accept": "application/json"})
        self.assertEqual(xhr.status_code, 401)
        self.assertEqual(xhr.get_json()["error"], "unauthorized")

    def test_the_cookie_is_marked_secure_over_https(self):
        resp = self.client.get("/api/all", headers={"X-API-Key": KEY, "X-Forwarded-Proto": "https"})
        self.assertIn("Secure", resp.headers.get("Set-Cookie", ""))

    def test_the_key_never_reaches_the_browser(self):
        body = self.client.get("/api/config", headers={"X-API-Key": KEY}).get_data(as_text=True)
        self.assertNotIn(KEY, body)


class NoKeyConfiguredTest(AuthTestBase):
    """The upgrade path: an install that sets nothing must behave as it always did."""
    ENV = {"DEMO": "1"}

    def test_endpoints_are_reachable_exactly_as_before(self):
        for path in ("/", "/api/config", "/api/all", "/api/topology", "/api/gpu", "/api/threats"):
            self.assertEqual(self.client.get(path).status_code, 200, path)

    def test_the_empty_header_bypass_is_still_not_an_authentication(self):
        # There is no gate to bypass here, but the comparison itself must never
        # say yes to "" -- otherwise setting a key later inherits the hole.
        self.assertFalse(self.auth.required())
        self.assertFalse(self.auth._matches("", ""))
        self.assertFalse(self.auth._matches(None, None))
        with self.flask_app.test_request_context("/api/all", headers={"X-API-Key": ""}):
            from flask import request
            self.assertEqual(self.auth.check(request), (False, False))
        resp = self.client.get("/api/all", headers={"X-API-Key": ""})
        self.assertEqual(resp.status_code, 200)                       # unchanged behaviour
        self.assertNotIn("galaxy_session", resp.headers.get("Set-Cookie", ""))

    def test_login_is_not_offered_when_there_is_nothing_to_log_in_to(self):
        self.assertEqual(self.client.get("/login").status_code, 404)


class LiveRoutesTest(EveryRouteGatedMixin, AuthTestBase):
    """The live route set (no fixtures), and /setup keeping its own separate token gate."""
    ENV = {"DASH_API_KEY": KEY, "SETUP_TOKEN": "example-setup-token-123456"}

    def test_setup_is_reachable_with_the_setup_token_alone(self):
        self.assertEqual(self.client.get("/setup").status_code, 200)
        self.assertEqual(self.client.get("/api/setup/schema").status_code, 401)
        ok = self.client.get("/api/setup/schema", headers={"X-Setup-Token": "example-setup-token-123456"})
        self.assertEqual(ok.status_code, 200)

    def test_the_dashboard_key_is_a_secret_field_in_the_wizard(self):
        s = self.client.get("/api/setup/schema",
                            headers={"X-Setup-Token": "example-setup-token-123456"}).get_json()
        section = next(x for x in s["sections"] if x["id"] == "access")
        field = next(f for f in section["fields"] if f["env"] == "DASH_API_KEY")
        self.assertTrue(field["secret"])
        self.assertEqual(field["type"], "password")
        self.assertNotIn(KEY, self.client.get("/api/setup/config",
                                              headers={"X-Setup-Token": "example-setup-token-123456"}
                                              ).get_data(as_text=True))

    def test_the_live_route_set_is_the_one_a_deployment_serves(self):
        # Not demo mode here, so these are the real views, not the fixture ones.
        paths = {concrete(r) for r in gated_rules(self.flask_app)}
        for path in ("/api/all", "/api/inventory", "/api/telemetry", "/api/prom", "/api/history",
                     "/api/showtime", "/api/threats", "/cam/x.jpg", "/api/chat"):
            self.assertIn(path, paths, path)


class ConfiguredThroughTheWizardTest(AuthTestBase):
    """The key is a config.py field, so /setup can set it like any other secret."""
    ENV = {"SETUP_TOKEN": "example-setup-token-123456"}

    def test_a_key_saved_by_the_wizard_gates_the_next_start(self):
        resp = self.client.post("/api/setup/config", json={"access": {"api_key": KEY}},
                                headers={"X-Setup-Token": "example-setup-token-123456"})
        self.assertEqual(resp.status_code, 200)
        with open(os.path.join(self.td.name, "config.json")) as fh:
            self.assertEqual(json.load(fh)["access"]["api_key"], KEY)
        # Restart: same config.json, nothing in the environment.
        clear_modules()
        restarted = importlib.import_module("app").app.test_client()
        self.assertEqual(restarted.get("/api/all").status_code, 401)
        self.assertEqual(restarted.get("/api/all", headers={"X-API-Key": KEY}).status_code, 200)


class ExposureWarningTest(unittest.TestCase):
    """The loud banner: no key + not demo + not loopback, and only then."""

    def tearDown(self):
        clean_env()
        clear_modules()

    def warn(self, **env):
        clean_env()
        clear_modules()
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        os.environ.update({"CONFIG_FILE": os.path.join(td.name, "config.json"),
                           "DATA_DIR": td.name, "ENABLE_GPU": "false"})
        os.environ.update(env)
        return importlib.import_module("auth").warn_if_exposed()

    def test_it_fires_on_the_configuration_that_exposes_everything(self):
        self.assertTrue(self.warn(LISTEN_HOST="0.0.0.0"))
        self.assertTrue(self.warn(LISTEN_HOST="10.0.0.51"))
        self.assertTrue(self.warn(LISTEN_HOST="::"))

    def test_it_stays_quiet_when_the_dashboard_is_not_exposed(self):
        self.assertFalse(self.warn(LISTEN_HOST="0.0.0.0", DASH_API_KEY=KEY))
        self.assertFalse(self.warn(LISTEN_HOST="127.0.0.1"))
        self.assertFalse(self.warn(LISTEN_HOST="localhost"))
        self.assertFalse(self.warn(LISTEN_HOST="::1"))
        self.assertFalse(self.warn(LISTEN_HOST="0.0.0.0", DEMO="1"))


if __name__ == "__main__":
    unittest.main()
