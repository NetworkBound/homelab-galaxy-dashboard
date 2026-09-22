#!/usr/bin/env python3
"""auth.py — the optional shared key in front of everything this app serves.

The dashboard draws a complete picture of an infrastructure: every guest with
its id and address, the network topology, the UniFi and Zabbix state, CrowdSec
findings, camera names, storage layout. Historically it has had no gate of its
own, on the assumption stated in the README: it lives on a trusted VLAN, behind
a reverse proxy or SSO that does the authenticating. That assumption is right
for most installs and wrong for some, and nothing in the app ever said which
one you were running.

So: set ``DASH_API_KEY`` and every route requires it. Leave it unset and
nothing at all changes — an install that upgrades must not lock itself out, and
the advice to front the dashboard with a proxy still stands either way. This is
defence in depth, not a licence to put the thing on the internet.

The gate is a ``before_request`` hook rather than a decorator per view, because
this file cannot be the thing that has to be remembered: a route added to
``app.py``, ``demo.py``, ``showtime.py``, ``threats.py`` or an add-on next year
is covered the moment it is registered, with no further thought.

How a caller presents the key, in the order we look:

    X-API-Key: <key>     scripts, curl, the lights driver in deploy/lights/
    ?key=<key>           a kiosk browser you can only hand a URL (it lands in
                         access logs, so prefer the form below)
    the session cookie   set after either of the above succeeded

Whoever presents the key correctly is handed that cookie (``HttpOnly``,
``SameSite=Lax``, ``Secure`` over HTTPS), because header-only auth cannot work
here: the front end fetches a dozen endpoints with a bare ``fetch()`` and
subscribes to four ``EventSource`` streams, and neither can set a header. A
same-origin cookie the browser attaches by itself is the only thing that
reaches all of them. A human with the key in hand gets a form at ``/login``.

The cookie carries an HMAC of the key, never the key: a stolen browser profile
then does not hand over the value that also sits in ``.env``. It is derived
rather than random so that it survives a restart (a wall display should not
need a human after every deploy) and so that no session state has to be kept.

Not gated: ``/login`` itself, and ``/setup`` + ``/api/setup/*``, which carry
their own token gate in ``setup.py``.
"""
import hmac
import ipaddress
from hashlib import sha256

from flask import Response, g, jsonify, redirect, request

import config

COOKIE = "galaxy_session"
COOKIE_MAX_AGE = 30 * 24 * 3600      # a wall display should not be asked again every day

# Paths this gate never touches. /setup and /api/setup/* have their own token
# (setup.py); /login has to be reachable to be of any use.
OPEN_PATHS = ("/login", "/setup")
OPEN_PREFIXES = ("/api/setup/",)


def required():
    """True when a key is configured. Everything below is a no-op when it is not."""
    return bool(config.DASH_API_KEY)


def _session_value():
    """The cookie's value: proof of the key, derived from it, never the key itself."""
    if not config.DASH_API_KEY:
        return ""
    return hmac.new(config.DASH_API_KEY.encode(), b"galaxy-session-v1", sha256).hexdigest()


def _matches(sent, expected):
    """Constant-time compare in which an empty or missing value never matches.

    Both halves matter. ``compare_digest`` because a plain ``!=`` on a secret
    leaks its prefix by timing (``setup.py`` does the same for its token). And
    the emptiness check first, because ``"" == ""`` is true: a gate that only
    compares lets ``X-API-Key:`` with no value through on any install that
    never configured a key — open to anyone who sends an empty header, while
    still 401ing the dashboard's own front end. Fail closed on both sides.
    """
    if not sent or not expected:
        return False
    return hmac.compare_digest(str(sent), str(expected))


def _presented_key(req):
    return req.headers.get("X-API-Key") or req.args.get("key") or ""


def check(req):
    """``(authenticated, fresh)``; ``fresh`` means a key was just presented and is owed a cookie."""
    if _matches(_presented_key(req), config.DASH_API_KEY):
        return True, True
    return _matches(req.cookies.get(COOKIE), _session_value()), False


def _https(req):
    """Did this request arrive over TLS, directly or through a terminating proxy?

    Trusting ``X-Forwarded-Proto`` is safe here: the only thing a client can do
    by forging it is ask for its *own* cookie to be marked ``Secure``.
    """
    if req.is_secure:
        return True
    return (req.headers.get("X-Forwarded-Proto", "").split(",")[0].strip().lower() == "https")


def _safe_next(raw):
    """Only ever redirect to a path on this site — never to whatever ?next= says."""
    nxt = (raw or "/").strip()
    if not nxt.startswith("/") or nxt.startswith("//"):
        return "/"
    return nxt


def _escape(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


# The page a browser gets instead of a raw 401, and the same form at /login.
# Self-contained on purpose: /static is gated too, so a login page that pulled
# a stylesheet would be a login page with no stylesheet.
_LOGIN_PAGE = """<!doctype html><meta charset="utf-8"><title>__BRAND__</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font:15px/1.6 system-ui,sans-serif;background:#0b1020;color:#cfe;display:flex;
             align-items:center;justify-content:center;min-height:90vh;margin:0">
<form method="post" action="/login" style="width:min(26rem,90vw)">
  <h1 style="font-size:1.3rem;letter-spacing:.14em;margin:0 0 .3rem">__BRAND__</h1>
  <p style="opacity:.7;margin:0 0 1.2rem">This dashboard is key-protected.</p>
  <input type="hidden" name="next" value="__NEXT__">
  <input type="password" name="key" autofocus autocomplete="current-password" placeholder="Dashboard key"
         style="width:100%;box-sizing:border-box;padding:.7rem;border-radius:.5rem;border:1px solid #2a3a5a;
                background:#0f1730;color:#cfe;font:inherit">
  <button type="submit" style="margin-top:.7rem;width:100%;padding:.7rem;border-radius:.5rem;border:0;
                background:#2a5aff;color:#fff;font:inherit;cursor:pointer">Unlock</button>
  __ERROR__
  <p style="opacity:.45;margin-top:1.4rem;font-size:.85rem">Scripts can send the same value as an
  <code>X-API-Key</code> header instead. The key is <code>DASH_API_KEY</code> on the server.__SETUP__</p>
</form></body>"""

_ERROR_HTML = ('<p style="margin-top:.8rem;color:#ff8b9a">That key was not accepted.</p>')

# Someone who sets a key before finishing configuration would otherwise meet
# this form with no way past it; /setup has its own token and is not gated here.
_SETUP_HINT = ' Still setting up? <a href="/setup" style="color:#8fb0ff">/setup</a> has its own token.'


def login_page(next_path="/", error=False):
    hint = _SETUP_HINT if (config.SETUP_UI and not config.DEMO) else ""
    return (_LOGIN_PAGE.replace("__BRAND__", _escape(config.BRAND or "GALAXY"))
            .replace("__NEXT__", _escape(_safe_next(next_path)))
            .replace("__SETUP__", hint)
            .replace("__ERROR__", _ERROR_HTML if error else ""))


def _wants_html(req):
    """A person navigating, as opposed to one of the front end's XHRs."""
    return req.method in ("GET", "HEAD") and "text/html" in (req.headers.get("Accept") or "")


def install(app):
    """Register the gate and ``/login``. Safe to call when no key is configured."""

    @app.before_request
    def _gate():
        if not required():
            return None                                   # unconfigured: behave exactly as before
        p = request.path
        if p in OPEN_PATHS or p.startswith(OPEN_PREFIXES):
            return None
        ok, fresh = check(request)
        if ok:
            g.galaxy_fresh_auth = fresh
            return None
        if _wants_html(request):
            return Response(login_page(request.path), status=401, mimetype="text/html")
        return jsonify({"error": "unauthorized",
                        "detail": "send the dashboard key as X-API-Key, or sign in at /login"}), 401

    @app.route("/login", methods=["GET", "POST"])
    def login():
        """Trade the key for the session cookie, so bare fetch()/EventSource work."""
        if not required():
            return Response("No dashboard key is configured; nothing to sign in to.",
                            status=404, mimetype="text/plain")
        if request.method == "GET":
            return Response(login_page(request.args.get("next", "/")), mimetype="text/html")
        body = request.get_json(silent=True) or {}
        sent = body.get("key") or request.form.get("key") or _presented_key(request)
        nxt = _safe_next(body.get("next") or request.form.get("next") or "/")
        if not _matches(sent, config.DASH_API_KEY):
            if request.is_json:
                return jsonify({"ok": False, "error": "unauthorized"}), 401
            return Response(login_page(nxt, error=True), status=401, mimetype="text/html")
        g.galaxy_fresh_auth = True
        if request.is_json:
            return jsonify({"ok": True})
        return redirect(nxt, code=303)

    @app.after_request
    def _issue_cookie(resp):
        # One place decides the cookie's flags, whether the key arrived at
        # /login or as a header on any other route.
        if g.get("galaxy_fresh_auth") and required():
            resp.set_cookie(COOKIE, _session_value(), max_age=COOKIE_MAX_AGE, httponly=True,
                            samesite="Lax", secure=_https(request), path="/")
        return resp

    return app


# --------------------------------------------------------------------- boot --
def _is_loopback(host):
    h = (host or "").strip().strip("[]")
    if not h or h in ("0.0.0.0", "::", "*"):      # every interface
        return False
    if h in ("localhost", "localhost.localdomain"):
        return True
    try:
        return ipaddress.ip_address(h).is_loopback
    except ValueError:
        return False                              # a name we will not resolve here: assume reachable


def warn_if_exposed():
    """Shout when the dashboard is about to serve the whole inventory to the network.

    Exactly one configuration deserves this: no key, not demo fixtures, and
    bound to something other than loopback. Silence in every other case, so the
    warning keeps meaning something.
    """
    if required() or config.DEMO or _is_loopback(config.LISTEN_HOST):
        return False
    bar = "!" * 74
    print(f"\n{bar}\n"
          f"  WARNING: listening on {config.LISTEN_HOST}:{config.LISTEN_PORT} with NO AUTHENTICATION.\n"
          "  Anything that can reach this port gets the full picture of this\n"
          "  infrastructure: every guest and its address, the topology, alerts,\n"
          "  cameras, storage. There is no login in front of it.\n\n"
          "  Fix it in one of these ways:\n"
          "    * set DASH_API_KEY (or /setup -> Access control) to require a key\n"
          "    * set LISTEN_HOST=127.0.0.1 and front it with a reverse proxy / SSO\n"
          "    * leave it as is only on a network you trust completely\n"
          f"{bar}\n", flush=True)
    return True
