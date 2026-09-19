# Add-ons

Drop a Python file in this directory and it becomes a row in the **ADD-ONS**
panel on the wall. No registration, no restart of anything but the dashboard.

```python
# addons/backup_check.py
TITLE = "Backups"        # panel title (default: the file name)
INTERVAL = 600           # seconds between poll() calls (default 60, minimum 5)

def enabled(config):     # optional - return False to skip this add-on entirely
    return bool(config.PVE_NODES)

def poll(config):        # runs in its own daemon thread
    return {"status": "warn",                       # up | warn | down
            "rows": [{"k": "nightly job", "v": "ok · 02:14"},
                     {"k": "offsite copy", "v": "3 days old", "cls": "warn"}]}   # cls: ok | warn | bad

def install(app, data):  # optional - add your own Flask routes
    @app.route("/api/addons/backup_check/raw")
    def raw(): ...
```

Rules the loader enforces so one add-on can never hurt another:

- Each add-on polls on its own thread; a raised exception becomes
  `status: "down"` with `error` set, and the loop keeps going.
- An import error still lists the add-on (as `down`) so you can see it broke.
- `config` is the resolved `config` module (`config.PROM_URL`, `config.DATA_DIR`, ...).
- Results land in `/api/all` under `addons[<id>]` as
  `{"title", "status", "rows", "ts", "error"}`; `/api/config.addons` lists the ids.
- Files starting with `_` are ignored. In demo mode add-ons are skipped unless
  `DEMO_ADDONS=1`. Another directory can be used with `ADDONS_DIR`.

Two examples ship here:

| File | What it does |
|---|---|
| `example_speedtest.py` | Parses `speedtest-cli --json` (or Ookla `speedtest`) every 30 min; reports `down` with the reason if neither is installed. |
| `example_http_json.py` | Generic: fetch `ADDON_HTTP_URL`, show `ADDON_HTTP_KEYS` (dotted paths, `path=Label`) as rows. Skipped until the URL is set. |
