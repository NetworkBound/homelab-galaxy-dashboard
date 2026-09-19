"""Example add-on: last speedtest result, via the ``speedtest-cli`` (or Ookla ``speedtest``) binary.

Reports ``down`` with a helpful error when neither binary is installed, so a
fresh install shows what is missing instead of an empty panel. Runs every 30
minutes; a speedtest costs bandwidth, so keep INTERVAL generous.
"""
import json
import shutil
import subprocess
import time

TITLE = "Speedtest"
INTERVAL = 1800

_last = {"ts": 0.0, "rows": None}


def _run():
    if shutil.which("speedtest-cli"):
        out = subprocess.run(["speedtest-cli", "--json"], capture_output=True, text=True, timeout=120)
        j = json.loads(out.stdout or "{}")
        return j.get("download", 0) / 1e6, j.get("upload", 0) / 1e6, j.get("ping")
    if shutil.which("speedtest"):
        out = subprocess.run(["speedtest", "--format=json", "--accept-license", "--accept-gdpr"],
                             capture_output=True, text=True, timeout=120)
        j = json.loads(out.stdout or "{}")
        return (j.get("download", {}).get("bandwidth", 0) * 8 / 1e6,
                j.get("upload", {}).get("bandwidth", 0) * 8 / 1e6,
                (j.get("ping") or {}).get("latency"))
    raise RuntimeError("neither speedtest-cli nor speedtest is installed (pip install speedtest-cli)")


def poll(config):
    down, up, ping = _run()
    _last.update({"ts": time.time()})

    def cls(v, good, warn):
        return "ok" if v >= good else "warn" if v >= warn else "bad"
    return {"status": "up", "rows": [
        {"k": "down", "v": f"{down:.0f} Mb/s", "cls": cls(down, 100, 25)},
        {"k": "up", "v": f"{up:.0f} Mb/s", "cls": cls(up, 20, 5)},
        {"k": "ping", "v": f"{ping:.0f} ms" if ping is not None else "?",
         "cls": ("ok" if ping < 30 else "warn" if ping < 80 else "bad") if ping is not None else None},
        {"k": "last run", "v": time.strftime("%H:%M")},
    ]}
