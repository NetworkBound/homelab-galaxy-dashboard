"""setup.py - the browser setup wizard's back end.

The page itself is ``templates/setup.html``; this module provides the API it
renders from, so the field list is never hardcoded in the front end:

  GET  /setup                    the page (unless SETUP_UI=false)
  GET  /api/setup/schema         sections + fields (label, type, help, required,
                                 current value with secrets masked as "••••")
  GET  /api/setup/config         current effective config, secrets masked
  POST /api/setup/test           {"section": "zabbix", "values": {...}} -> try the backend
  POST /api/setup/config         {...} -> validate, merge (a masked value keeps the
                                 stored secret), write config.json (0600)
  POST /api/setup/apply          re-execute the process so the pollers pick up
                                 the new configuration (systemd sees the same PID)

Every ``/api/setup/*`` request carries ``X-Setup-Token``. The token is
``SETUP_TOKEN`` or, when unset, generated at first start, printed on the console
(``[setup] token: ...``) and stored next to config.json as ``setup-token`` (0600).

Connection tests never log the credential; they answer ``{"ok": true, "detail"}``
or ``{"ok": false, "error"}`` only.
"""
import hmac
import json
import os
import secrets
import sys
import threading
import time
from urllib.parse import urlsplit

import requests
from flask import Response, jsonify, render_template, request
from jinja2 import TemplateNotFound

import config

MASK = "••••"
_token = None


# ---------------------------------------------------------------- token ----
def token_path():
    return os.path.join(os.path.dirname(os.path.abspath(config.CONFIG_FILE)), "setup-token")


def get_token():
    """SETUP_TOKEN, else the persisted one, else a fresh one (persisted 0600 when possible)."""
    global _token
    if _token:
        return _token
    if config.SETUP_TOKEN:
        _token = config.SETUP_TOKEN
        return _token
    p = token_path()
    try:
        with open(p) as fh:
            t = fh.read().strip()
        if len(t) >= 16:
            _token = t
            return _token
    except OSError:
        pass
    _token = secrets.token_urlsafe(24)
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(_token + "\n")
    except OSError as e:
        print(f"[setup] could not persist the token ({e}); it changes on every start", flush=True)
    return _token


def _authorised(req):
    sent = req.headers.get("X-Setup-Token") or req.args.get("token") or ""
    return bool(sent) and hmac.compare_digest(sent, get_token())


# ---------------------------------------------------------------- values ----
def _field_value(f):
    v = config.get(f["env"])
    if f["secret"]:
        return MASK if v else ""
    return v


def _mask_items(section, items):
    out = []
    for it in items:
        row = dict(it)
        for f in section["item_fields"]:
            if f["secret"] and row.get(f["key"]):
                row[f["key"]] = MASK
        out.append(row)
    return out


def schema():
    """Sections + fields with current values, secrets masked."""
    sections = []
    for s in config.SECTIONS:
        sec = {"id": s["id"], "title": s["title"], "help": s.get("help", ""),
               "test": bool(s.get("test")), "list": bool(s.get("list")), "hidden": bool(s.get("hidden")),
               "fields": []}
        for f in s.get("fields", []):
            sec["fields"].append({**{k: f[k] for k in ("env", "key", "label", "type", "help", "required",
                                                        "placeholder", "options", "secret", "default")},
                                  "value": _field_value(f), "from_env": config.from_env(f["env"])})
        if s.get("list"):
            sec["prefix"] = s["prefix"]
            sec["item_fields"] = [{k: f[k] for k in ("env", "key", "label", "type", "help", "required",
                                                     "placeholder", "options", "secret", "default")}
                                  for f in s["item_fields"]]
            sec["items"] = _mask_items(s, config.get_list(s["id"]))
            sec["from_env"] = config.list_from_env(s["id"])
        sections.append(sec)
    return {"version": config.VERSION, "config_file": config.CONFIG_FILE, "configured": config.is_configured(),
            "demo": config.DEMO, "sections": sections}


def current():
    """Effective config in config.json layout, secrets masked."""
    out = {}
    for s in config.SECTIONS:
        if s.get("list"):
            out[s["id"]] = _mask_items(s, config.get_list(s["id"]))
            if s.get("fields"):
                out[s["id"] + "_settings"] = {f["key"]: _field_value(f) for f in s["fields"]}
        else:
            out[s["id"]] = {f["key"]: _field_value(f) for f in s.get("fields", [])}
    return out


def _stored_secret(section, key, index=None, name=None):
    """The secret currently on disk / in the environment for a masked value.

    Reads config.json afresh rather than the copy config.py loaded at import, so
    two saves in one process (the wizard's normal flow) keep the stored secret."""
    fresh = config.load_json_config()
    sid = section["id"]
    if section.get("list"):
        if config.list_from_env(sid):
            items = config.get_list(sid)
        else:
            items = [it for it in (fresh.get(sid) or []) if isinstance(it, dict)]
        if name is not None:
            for it in items:
                if it.get(section["item_fields"][0]["key"]) == name:
                    return it.get(key) or ""
        if index is not None and 0 <= index < len(items):
            return items[index].get(key) or ""
        return ""
    f = next((f for f in section.get("fields", []) if f["key"] == key), None)
    if f is None:
        return ""
    if config.from_env(f["env"]):
        return os.environ[f["env"]].strip()
    sec = fresh.get(sid + "_settings" if section.get("list") else sid)
    return (sec.get(key) if isinstance(sec, dict) else None) or ""


def _unmask_items(section, items):
    first = section["item_fields"][0]["key"]
    out = []
    for i, it in enumerate(items or []):
        if not isinstance(it, dict):
            continue
        row = {}
        for f in section["item_fields"]:
            v = it.get(f["key"], f["default"])
            if f["secret"] and v == MASK:
                v = _stored_secret(section, f["key"], index=i, name=it.get(first))
            row[f["key"]] = v
        if any(v not in (None, "", [], {}) for v in row.values()):   # skip only fully empty rows
            out.append(row)
    return out


def _unmask_fields(section, values):
    out = {}
    for f in section.get("fields", []):
        if f["key"] not in values:
            continue
        v = values[f["key"]]
        if f["secret"] and v == MASK:
            v = _stored_secret(section, f["key"])
        out[f["key"]] = v
    return out


def _validate(section, values):
    """Type-check and coerce one section's values (dict, or list for list sections)."""
    problems = []

    def coerce(f, v):
        t = f["type"]
        if v is None or v == "":
            return f["default"] if t in ("int", "bool", "json", "csv") else ""
        if t == "int":
            try:
                return int(v)
            except (TypeError, ValueError):
                problems.append("{} must be a number".format(f["label"])); return f["default"]
        if t == "bool":
            return v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
        if t == "csv":
            return [x.strip() for x in (v if isinstance(v, list) else str(v).split(",")) if str(x).strip()]
        if t == "json":
            if isinstance(v, (dict, list)):
                return v
            try:
                return json.loads(str(v))
            except ValueError:
                problems.append("{} must be valid JSON".format(f["label"])); return f["default"]
        if t == "url":
            v = str(v).strip()
            if v and not urlsplit(v).scheme:
                problems.append("{} must start with http:// or https://".format(f["label"]))
            return v
        return str(v).strip()

    if section.get("list"):
        items = []
        for it in values if isinstance(values, list) else []:
            row = {f["key"]: coerce(f, it.get(f["key"])) for f in section["item_fields"]}
            for f in section["item_fields"]:
                if f["required"] and not row.get(f["key"]):
                    problems.append("{}: {} is required".format(section["title"], f["label"]))
            items.append(row)
        return items, problems
    out = {}
    for f in section.get("fields", []):
        if f["key"] in values:
            out[f["key"]] = coerce(f, values[f["key"]])
    return out, problems


def save(body):
    """Merge ``body`` (config.json layout) over the stored file and write it 0600."""
    if not isinstance(body, dict):
        return {"ok": False, "error": "expected a JSON object"}, 400
    stored = config.load_json_config()
    problems = []
    for s in config.SECTIONS:
        sid = s["id"]
        if s.get("list"):
            if sid in body:
                items, p = _validate(s, _unmask_items(s, body[sid]))
                problems += p
                stored[sid] = items
            if sid + "_settings" in body and isinstance(body[sid + "_settings"], dict):
                # A list section's *_settings block holds the section-level
                # fields, not rows, so it must take _validate's dict branch.
                # Passing the section as-is returned a list and the merge below
                # raised "'list' object is not a mapping" on every save.
                vals, p = _validate(dict(s, list=False), _unmask_fields(s, body[sid + "_settings"]))
                problems += p
                stored[sid + "_settings"] = {**(stored.get(sid + "_settings") or {}), **vals}
        elif sid in body and isinstance(body[sid], dict):
            vals, p = _validate(s, _unmask_fields(s, body[sid]))
            problems += p
            stored[sid] = {**(stored.get(sid) or {}), **vals}
    if problems:
        return {"ok": False, "error": "; ".join(problems[:8]), "problems": problems}, 400
    try:
        write_config(stored)
    except OSError as e:
        return {"ok": False, "error": f"cannot write {config.CONFIG_FILE}: {e}"}, 500
    return {"ok": True, "restart": True, "config_file": config.CONFIG_FILE}, 200


def write_config(data, path=None):
    path = path or config.CONFIG_FILE
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)
    os.chmod(path, 0o600)


# ---------------------------------------------------------------- tests ----
def _url(v, key="url"):
    u = str((v or {}).get(key) or "").strip().rstrip("/")
    if not u:
        raise ValueError("no URL given")
    return u


def _test_pve(v):
    items = v if isinstance(v, list) else [v]
    out = []
    for it in items:
        url = _url(it)
        H = {"Authorization": "PVEAPIToken=" + str(it.get("token") or "")}
        r = requests.get(url + "/api2/json/version", headers=H, verify=False, timeout=6)
        if r.status_code == 401:
            raise RuntimeError(f"{url}: token rejected (401)")
        r.raise_for_status()
        ver = (r.json().get("data") or {}).get("version", "?")
        nodes = requests.get(url + "/api2/json/nodes", headers=H, verify=False, timeout=6).json().get("data") or []
        names = [n.get("node") for n in nodes if n.get("node")]
        want = it.get("name")
        note = "" if not want or want in names else f" (configured name {want!r} not reported!)"
        out.append("Proxmox VE {} · nodes: {}{}".format(ver, ", ".join(names) or "?", note))
    return " | ".join(out)


def _test_zabbix(v):
    url = _url(v)
    ver = requests.post(url, json={"jsonrpc": "2.0", "method": "apiinfo.version", "params": {}, "id": 1},
                        timeout=8).json().get("result", "?")
    tok = requests.post(url, json={"jsonrpc": "2.0", "method": "user.login",
                                   "params": {"username": v.get("user"), "password": v.get("pass")}, "id": 2},
                        timeout=8).json()
    if not tok.get("result"):
        raise RuntimeError("login failed: %s" % ((tok.get("error") or {}).get("data") or "no token"))
    hosts = requests.post(url, headers={"Authorization": "Bearer " + tok["result"]},
                          json={"jsonrpc": "2.0", "method": "host.get", "params": {"countOutput": True}, "id": 3},
                          timeout=8).json().get("result")
    return f"Zabbix {ver} · {hosts} hosts"


def _test_unifi(v):
    url = _url(v)
    s = requests.Session()
    r = s.post(url + "/api/auth/login", json={"username": v.get("user"), "password": v.get("pass")},
               verify=False, timeout=8)
    if r.status_code >= 400:
        raise RuntimeError(f"login failed ({r.status_code})")
    site = v.get("site") or "default"
    cl = s.get(url + f"/proxy/network/api/s/{site}/stat/sta", verify=False, timeout=8).json().get("data")
    if cl is None:
        raise RuntimeError(f"logged in, but site {site!r} returned no client list")
    return f"UniFi · {len(cl)} clients on site {site}"


def _test_frigate(v):
    st = requests.get(_url(v) + "/api/stats", timeout=6).json()
    ver = (st.get("service") or {}).get("version", "?")
    return f"Frigate {ver} · {len(st.get('cameras') or {})} cameras"


def _test_ollama(v):
    items = v if isinstance(v, list) else [v]
    out = []
    for it in items:
        j = requests.get(_url(it) + "/api/tags", timeout=6).json()
        out.append(f"{it.get('name') or it.get('url')}: {len(j.get('models') or [])} models")
    return "Ollama · " + ", ".join(out)


def _test_grafana(v):
    url = _url(v)
    h = requests.get(url + "/api/health", timeout=6).json()
    detail = "Grafana {}".format(h.get("version", "?"))
    if v.get("token"):
        r = requests.get(url + "/api/datasources", headers={"Authorization": "Bearer " + v["token"]}, timeout=6)
        if r.status_code == 401:
            raise RuntimeError("reachable, but the token was rejected (401)")
        r.raise_for_status()
        detail += f" · {len(r.json())} datasources"
    return detail


def _test_prometheus(v):
    url = _url(v)
    r = requests.get(url + "/-/ready", timeout=6)
    r.raise_for_status()
    up = requests.get(url + "/api/v1/query", params={"query": "count(up)"}, timeout=6).json()
    n = ((up.get("data") or {}).get("result") or [[None, [0, "0"]]])[0]
    return "Prometheus ready · %s targets" % (n.get("value", [0, "?"])[1] if isinstance(n, dict) else "?")


def _test_ntopng(v):
    url = _url(v)
    r = requests.get(url + "/lua/rest/v2/get/ntopng/interfaces.lua", auth=(v.get("user") or "admin", v.get("pass") or ""),
                     timeout=6)
    if r.status_code in (401, 403):
        raise RuntimeError(f"auth failed ({r.status_code})")
    r.raise_for_status()
    rsp = r.json().get("rsp") or []
    names = [it.get("ifname") for it in rsp if isinstance(it, dict)]
    want = v.get("ifname") or "vmbr0"
    return "ntopng · interfaces: {}{}".format(", ".join(names) or "?", "" if want in names else f" ({want!r} not found)")


def _test_netmap(v):
    j = requests.get(_url(v), timeout=6).json()
    return f"netmap · {len(j.get('devices') or [])} devices, {j.get('up', '?')} up"


def _test_cloudflared(v):
    t = requests.get(_url(v), timeout=6).text
    if "cloudflared_tunnel" not in t:
        raise RuntimeError("reachable, but no cloudflared_tunnel_* metrics in the response")
    ha = next((ln.split()[-1] for ln in t.splitlines() if ln.startswith("cloudflared_tunnel_ha_connections")), "?")
    return f"cloudflared metrics · {ha} HA connections"


def _test_crowdsec(v):
    j = requests.get(_url(v) + "/alerts.json", timeout=6).json()
    return f"CrowdSec export · {len(j or [])} alerts in the file"


def _test_akvorado(v):
    url = _url(v)
    r = requests.get(url + "/api/v0/healthcheck", timeout=6)
    if r.status_code >= 400:
        r = requests.get(url + "/", timeout=6)
    r.raise_for_status()
    return f"Akvorado answers ({r.status_code})"


def _test_secmon(v):
    s = requests.get(_url(v) + "/api/stats/summary", timeout=6).json()
    return "Security Monitor · level %s" % (s.get("threat_name") or s.get("threat_level", "?"))


def _test_cloudflare(v):
    if not (v.get("token") and v.get("zone_id")):
        raise RuntimeError("token and zone id are both required")
    import threats
    a = threats.cf_query(v["token"], v["zone_id"])
    return "Cloudflare analytics · {} viewers / {} requests in the last hour".format(a["viewers_1h"], a["requests_1h"])


def _test_audience(v):
    j = requests.get(_url(v), timeout=6).json()
    age = time.time() - float(j.get("ts") or 0)
    return "audience.json · {} viewers (5 min), written {:.0f} s ago{}".format(
        j.get("viewers_5m", "?"), age, " (STALE)" if age > 300 else "")


def _test_emby(v):
    url = _url(v)
    H = {"X-Emby-Token": v.get("api_key") or ""}
    r = requests.get(url + "/emby/System/Info", headers=H, timeout=6)
    if r.status_code == 404:
        r = requests.get(url + "/System/Info", headers=H, timeout=6)
    if r.status_code in (401, 403):
        raise RuntimeError(f"reachable, but the API key was rejected ({r.status_code})")
    r.raise_for_status()
    j = r.json()
    return "{} {} ({})".format(j.get("ProductName") or "Emby", j.get("Version", "?"), j.get("ServerName", "?"))


def _test_generic(v):
    url = _url(v)
    r = requests.get(url, timeout=6, verify=False)
    if r.status_code >= 300:
        raise RuntimeError(f"HTTP {r.status_code}")
    return f"HTTP {r.status_code} from {url}"


TESTS = {"pve": _test_pve, "zabbix": _test_zabbix, "unifi": _test_unifi, "frigate": _test_frigate,
         "ollama": _test_ollama, "grafana": _test_grafana, "prometheus": _test_prometheus,
         "ntopng": _test_ntopng, "netmap": _test_netmap, "cloudflared": _test_cloudflared,
         "crowdsec": _test_crowdsec, "akvorado": _test_akvorado, "secmon": _test_secmon,
         "cloudflare": _test_cloudflare, "audience": _test_audience, "emby": _test_emby}


def test(section_id, values):
    section = next((s for s in config.SECTIONS if s["id"] == section_id), None)
    if section is None:
        return {"ok": False, "error": f"unknown section {section_id!r}"}
    fn = TESTS.get(section_id, _test_generic)
    try:
        vals = _unmask_items(section, values) if section.get("list") else _unmask_fields(section, values or {})
        if section.get("list") and not vals:
            raise ValueError("nothing to test")
        return {"ok": True, "detail": fn(vals)}
    except Exception as e:
        return {"ok": False, "error": (f"{type(e).__name__}: {e}")[:200]}


# ---------------------------------------------------------------- routes ----
_FALLBACK_PAGE = """<!doctype html><meta charset="utf-8"><title>Setup</title>
<body style="font:15px/1.5 system-ui;background:#0b1020;color:#cfe;padding:2rem;max-width:48rem">
<h1>Setup wizard</h1>
<p><code>templates/setup.html</code> is not present in this checkout, but the API is:
<code>GET /api/setup/schema</code>, <code>POST /api/setup/test</code>,
<code>POST /api/setup/config</code>, <code>POST /api/setup/apply</code> — all with the
<code>X-Setup-Token</code> header printed on the console at start.</p>
<p>You can also configure with environment variables: see <code>.env.example</code>.</p></body>"""


def install(app):
    @app.before_request
    def _gate():
        if request.path.startswith("/api/setup/"):
            if not config.SETUP_UI:
                return jsonify({"ok": False, "error": "setup UI disabled (SETUP_UI=false)"}), 404
            if not _authorised(request):
                return jsonify({"ok": False, "error": "missing or wrong X-Setup-Token"}), 401
        return None

    @app.route("/setup")
    def setup_page():
        if not config.SETUP_UI:
            return Response("setup UI disabled", status=404, mimetype="text/plain")
        try:
            return render_template("setup.html")
        except TemplateNotFound:
            return Response(_FALLBACK_PAGE, mimetype="text/html")

    @app.route("/api/setup/schema")
    def setup_schema():
        return jsonify(schema())

    @app.route("/api/setup/config", methods=["GET", "POST"])
    def setup_config():
        if request.method == "POST":
            body, status = save(request.get_json(silent=True))
            return jsonify(body), status
        return jsonify(current())

    @app.route("/api/setup/test", methods=["POST"])
    def setup_test():
        d = request.get_json(silent=True) or {}
        return jsonify(test(str(d.get("section") or ""), d.get("values")))

    @app.route("/api/setup/apply", methods=["POST"])
    def setup_apply():
        def _reexec():
            time.sleep(0.6)
            sys.stdout.flush(); sys.stderr.flush()
            os.execv(sys.executable, [sys.executable] + sys.argv)
        threading.Thread(target=_reexec, daemon=True).start()
        return jsonify({"ok": True, "restarting": True})

    print(f"[setup] token: {get_token()}", flush=True)
    print(f"[setup] wizard at /setup (config file: {config.CONFIG_FILE})", flush=True)
