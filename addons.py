"""addons.py - load ``addons/<id>.py`` panels and poll them in isolation.

Any file ``addons/<id>.py`` (not starting with ``_``) is loaded at start
(skipped in demo mode unless ``DEMO_ADDONS=1``). It may define::

    TITLE = "Speedtest"          # panel title (default: the file name)
    INTERVAL = 600               # seconds between poll() calls (default 60)

    def enabled(config):         # optional: False -> the add-on is not loaded at all
        return True

    def poll(config):            # runs in its own thread; return a panel payload
        return {"status": "up", "rows": [{"k": "down", "v": "912 Mb/s", "cls": "ok"}]}

    def install(app, data):      # optional: add your own Flask routes
        ...

The loader writes ``DATA["addons"][id] = {"title", "status", "rows", "ts", "error"}``.
A raised exception (or a broken import) becomes ``status: "down"`` + ``error``
and never affects the other add-ons or the app. ``status`` is one of
``up | warn | down``; row ``cls`` is ``ok | warn | bad`` or absent.
See ``addons/README.md``.
"""
import importlib.util
import os
import threading
import time
import traceback

DATA = None
_loaded = {}          # id -> module (or None when the import failed)


def discover(addons_dir):
    """[(id, path)] for every loadable add-on file, sorted by id."""
    out = []
    try:
        names = sorted(os.listdir(addons_dir))
    except OSError:
        return out
    for fn in names:
        if not fn.endswith(".py") or fn.startswith("_"):
            continue
        out.append((fn[:-3], os.path.join(addons_dir, fn)))
    return out


def _normalise(aid, mod, result):
    title = str(getattr(mod, "TITLE", None) or aid) if mod else aid
    if not isinstance(result, dict):
        raise TypeError(f"poll() must return a dict, got {type(result).__name__}")
    status = str(result.get("status") or "up").lower()
    if status not in ("up", "warn", "down"):
        status = "up"
    rows = []
    for r in result.get("rows") or []:
        if not isinstance(r, dict):
            continue
        row = {"k": str(r.get("k", ""))[:48], "v": str(r.get("v", ""))[:96]}
        if r.get("cls") in ("ok", "warn", "bad"):
            row["cls"] = r["cls"]
        rows.append(row)
    return {"title": title, "status": status, "rows": rows[:24], "ts": time.time(),
            "error": (str(result["error"])[:160] if result.get("error") else None)}


def _fail(aid, mod, err):
    title = str(getattr(mod, "TITLE", None) or aid) if mod else aid
    return {"title": title, "status": "down", "rows": [], "ts": time.time(), "error": str(err)[:160]}


def _run(aid, mod, cfg):
    interval = getattr(mod, "INTERVAL", 60)
    try:
        interval = max(5, int(interval))
    except (TypeError, ValueError):
        interval = 60
    while True:
        try:
            DATA["addons"][aid] = _normalise(aid, mod, mod.poll(cfg))
        except Exception as e:
            DATA["addons"][aid] = _fail(aid, mod, f"{type(e).__name__}: {e}")
        time.sleep(interval)


def _import(aid, path):
    spec = importlib.util.spec_from_file_location("addon_" + aid, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load(app, data, cfg, addons_dir=None):
    """Import every add-on, register its routes, start its poll thread. Returns the ids."""
    global DATA
    DATA = data
    DATA.setdefault("addons", {})
    addons_dir = addons_dir or cfg.ADDONS_DIR
    ids = []
    for aid, path in discover(addons_dir):
        try:
            mod = _import(aid, path)
        except Exception as e:
            _loaded[aid] = None
            DATA["addons"][aid] = _fail(aid, None, f"import failed: {type(e).__name__}: {e}")
            print(f"[addons] {aid}: import failed: {traceback.format_exc().strip().splitlines()[-1]}", flush=True)
            ids.append(aid)
            continue
        try:
            if hasattr(mod, "enabled") and not mod.enabled(cfg):
                print(f"[addons] {aid}: disabled", flush=True)
                continue
        except Exception as e:
            print(f"[addons] {aid}: enabled() raised: {e}", flush=True)
            continue
        if not callable(getattr(mod, "poll", None)):
            DATA["addons"][aid] = _fail(aid, mod, "no poll(config) function")
            ids.append(aid)
            continue
        _loaded[aid] = mod
        if callable(getattr(mod, "install", None)):
            try:
                mod.install(app, DATA)
            except Exception as e:
                print(f"[addons] {aid}: install() failed: {e}", flush=True)
        DATA["addons"][aid] = {"title": str(getattr(mod, "TITLE", None) or aid), "status": "down",
                               "rows": [], "ts": 0, "error": "not polled yet"}
        threading.Thread(target=_run, args=(aid, mod, cfg), daemon=True, name="addon-" + aid).start()
        ids.append(aid)
    if ids:
        print("[addons] loaded:", ", ".join(ids), flush=True)
    return ids


def ids():
    """Add-on ids currently present in DATA (for /api/config)."""
    return sorted((DATA or {}).get("addons") or {})
