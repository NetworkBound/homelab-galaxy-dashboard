"""Example add-on: fetch a JSON URL and show chosen keys as rows.

Configured entirely by environment variables, so it doubles as a template for
"show me these numbers from that API":

    ADDON_HTTP_URL=http://10.0.0.90:8088/stats        # required; the add-on is skipped when unset
    ADDON_HTTP_TITLE=Build runner                      # panel title (default: the URL host)
    ADDON_HTTP_KEYS=queue.depth,workers,uptime         # dotted paths into the JSON; default: top-level scalars
    ADDON_HTTP_HEADERS={"Authorization": "Bearer ..."} # optional JSON dict of request headers
    ADDON_HTTP_INTERVAL=60

Keys may be renamed with ``path=Label`` (``queue.depth=Queue``). Any HTTP error
becomes ``status: down`` with the reason.
"""
import json
import os
from urllib.parse import urlsplit

import requests

TITLE = os.environ.get("ADDON_HTTP_TITLE") or (urlsplit(os.environ.get("ADDON_HTTP_URL", "")).hostname or "HTTP JSON")
try:
    INTERVAL = int(os.environ.get("ADDON_HTTP_INTERVAL", "60"))
except ValueError:
    INTERVAL = 60


def enabled(config):
    return bool(os.environ.get("ADDON_HTTP_URL", "").strip())


def _dig(obj, path):
    for part in path.split("."):
        if isinstance(obj, dict):
            obj = obj.get(part)
        elif isinstance(obj, list) and part.isdigit():
            obj = obj[int(part)] if int(part) < len(obj) else None
        else:
            return None
    return obj


def _fmt(v):
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        return f"{v:.2f}"
    if isinstance(v, (dict, list)):
        return json.dumps(v)[:60]
    return str(v)


def poll(config):
    url = os.environ["ADDON_HTTP_URL"].strip()
    headers = {}
    raw = os.environ.get("ADDON_HTTP_HEADERS", "").strip()
    if raw:
        headers = json.loads(raw)
    r = requests.get(url, headers=headers, timeout=8)
    r.raise_for_status()
    j = r.json()
    keys = [k.strip() for k in os.environ.get("ADDON_HTTP_KEYS", "").split(",") if k.strip()]
    rows = []
    if keys:
        for spec in keys:
            path, _, label = spec.partition("=")
            v = _dig(j, path)
            rows.append({"k": label or path, "v": _fmt(v) if v is not None else "—",
                         "cls": None if v is not None else "warn"})
    elif isinstance(j, dict):
        for k, v in list(j.items())[:12]:
            if not isinstance(v, (dict, list)):
                rows.append({"k": str(k), "v": _fmt(v)})
    return {"status": "up" if rows else "warn", "rows": rows,
            "error": None if rows else "no scalar keys found; set ADDON_HTTP_KEYS"}
