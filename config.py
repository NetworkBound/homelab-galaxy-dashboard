"""Central configuration for the Galaxy dashboard.

Everything that is specific to *your* homelab lives here, and everything here is
driven by environment variables (see ``.env.example``). No credentials and no
site-specific addresses are baked into the application code.

Two kinds of settings:

* **Endpoints** — where a data source lives (``ZBX_URL``, ``UNIFI_URL``, ...).
  Unset endpoints are simply skipped: the matching poller no-ops and the
  dashboard renders without that layer. You can run this with only Proxmox
  configured and still get a galaxy.
* **Credentials** — read from the environment only. They are never logged, never
  written to disk, and never sent to the browser.

Nodes and service probes are lists, configured with indexed env vars so an
arbitrary number can be declared without editing code::

    PVE_0_NAME=pve1
    PVE_0_URL=https://10.0.0.10:8006
    PVE_0_TOKEN=dashboard@pve!readonly=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    PVE_1_NAME=pve2
    ...
"""
import os


def _env(name, default=""):
    return os.environ.get(name, default).strip()


def _flag(name, default=False):
    v = _env(name)
    if not v:
        return default
    return v.lower() in ("1", "true", "yes", "on")


def _int(name, default):
    try:
        return int(_env(name) or default)
    except ValueError:
        return default


def _indexed(prefix, fields, limit=16):
    """Collect ``PREFIX_<n>_<FIELD>`` env vars into a list of dicts.

    Stops at the first index with no value for the first field, so the numbering
    must be contiguous from 0. Returns ``[]`` when nothing is configured, which
    every caller treats as "this data source is disabled".
    """
    out = []
    for i in range(limit):
        first = _env(f"{prefix}_{i}_{fields[0].upper()}")
        if not first:
            break
        out.append({f: _env(f"{prefix}_{i}_{f.upper()}") for f in fields})
    return out


# --------------------------------------------------------------------------
# Proxmox VE — the backbone. Each node becomes one spiral galaxy in the scene.
# Use a read-only API token (PVEAuditor on /); never a root password.
# --------------------------------------------------------------------------
PVE_NODES = [
    {"node": n["name"], "url": n["url"].rstrip("/"), "token": n["token"]}
    for n in _indexed("PVE", ["name", "url", "token"])
]
PVE_VERIFY_TLS = _flag("PVE_VERIFY_TLS", False)

# --------------------------------------------------------------------------
# Zabbix — host and problem counts, per-host severity.  Zabbix >= 7.0 requires
# Bearer-token auth; see docs/data-sources.md.
# --------------------------------------------------------------------------
ZBX_URL = _env("ZBX_URL")
ZBX_USER = _env("ZBX_USER")
ZBX_PASS = _env("ZBX_PASS")

# --------------------------------------------------------------------------
# UniFi controller — client count, device list, WAN throughput.
# --------------------------------------------------------------------------
UNIFI_URL = _env("UNIFI_URL")
UNIFI_USER = _env("UNIFI_USER")
UNIFI_PASS = _env("UNIFI_PASS")
UNIFI_SITE = _env("UNIFI_SITE", "default")

# --------------------------------------------------------------------------
# Optional layers. Each is skipped when its URL is unset.
# --------------------------------------------------------------------------
FRIGATE_URL = _env("FRIGATE_URL")          # NVR — live camera JPEGs as orbiting satellites
OLLAMA_URL = _env("OLLAMA_URL")            # local LLM — powers the in-scene chat box
OLLAMA_MODEL = _env("OLLAMA_MODEL", "qwen2.5:7b")
GRAFANA_URL = _env("GRAFANA_URL")
GRAFANA_TOKEN = _env("GRAFANA_TOKEN")
PROM_URL = _env("PROM_URL")                # Prometheus, for node_exporter style metrics
NETMAP_URL = _env("NETMAP_URL")            # LibreNMS topology JSON (see docs/data-sources.md)
NTOPNG_URL = _env("NTOPNG_URL")
NTOPNG_USER = _env("NTOPNG_USER", "admin")
NTOPNG_PASS = _env("NTOPNG_PASS")
NTOPNG_IFNAME = _env("NTOPNG_IFNAME", "vmbr0")

# Extra Prometheus GPU exporters for GPUs on *other* machines (nvidia_gpu_exporter).
#   GPUX_0_NAME=rig-2
#   GPUX_0_URL=http://10.0.0.20:9835/metrics
REMOTE_GPU_EXPORTERS = [
    {"name": e["name"], "host": e["name"], "url": e["url"], "name_prefix": e["name"]}
    for e in _indexed("GPUX", ["name", "url"])
]

# Generic hosts to show as nodes with an Ollama/node_exporter readout.
#   AISRV_0_NAME=rig-2
#   AISRV_0_IP=10.0.0.20
AI_SERVERS = [
    {
        "name": s["name"],
        "ip": s["ip"],
        "ollama": f"http://{s['ip']}:11434/api/tags",
        "node": f"http://{s['ip']}:9100/metrics",
    }
    for s in _indexed("AISRV", ["name", "ip"])
]

# --------------------------------------------------------------------------
# Service health probes — the coloured status pips.  Any HTTP endpoint that
# returns 2xx/3xx when healthy works.
#   SVC_0_NAME=grafana
#   SVC_0_CATEGORY=monitor
#   SVC_0_URL=http://10.0.0.30:3000/api/health
# --------------------------------------------------------------------------
SERVICE_PROBES = [
    (s["name"], s["category"] or "infra", s["url"])
    for s in _indexed("SVC", ["name", "category", "url"], limit=64)
]

# --------------------------------------------------------------------------
# Arbitrary "fleet" of extra services shown as up/down pips, plus one optional
# JSON stats endpoint rendered in the same panel.
#   FLEET_0_NAME=build-runner
#   FLEET_0_HOST=10.0.0.40
#   FLEET_0_PORT=22
#   FLEET_STATS_URL=http://10.0.0.40:8088/stats
# --------------------------------------------------------------------------
FLEET_TARGETS = _indexed("FLEET", ["name", "host", "port"], limit=32)
FLEET_STATS_URL = _env("FLEET_STATS_URL")

# --------------------------------------------------------------------------
# Local behaviour
# --------------------------------------------------------------------------
LISTEN_HOST = _env("LISTEN_HOST", "0.0.0.0")
LISTEN_PORT = _int("LISTEN_PORT", 8080)
POLL_INTERVAL = _int("POLL_INTERVAL", 20)      # seconds between data refreshes
METRICS_DB = _env("METRICS_DB", "metrics.db")  # sqlite history store
HISTORY_DAYS = _int("HISTORY_DAYS", 7)
ENABLE_GPU = _flag("ENABLE_GPU", True)         # NVML + server-side EGL render
ENABLE_GPU_RENDER = _flag("ENABLE_GPU_RENDER", False)


def missing_required():
    """Return a list of human-readable problems that would stop the app booting."""
    problems = []
    if not PVE_NODES:
        problems.append(
            "No Proxmox nodes configured. Set PVE_0_NAME / PVE_0_URL / PVE_0_TOKEN "
            "(see .env.example). The dashboard needs at least one node to draw."
        )
    for i, n in enumerate(PVE_NODES):
        if not n.get("token"):
            problems.append(f"PVE_{i}_TOKEN is empty for node {n['node']!r}.")
    if ZBX_URL and not (ZBX_USER and ZBX_PASS):
        problems.append("ZBX_URL is set but ZBX_USER / ZBX_PASS are not.")
    if UNIFI_URL and not (UNIFI_USER and UNIFI_PASS):
        problems.append("UNIFI_URL is set but UNIFI_USER / UNIFI_PASS are not.")
    if GRAFANA_URL and not GRAFANA_TOKEN:
        problems.append("GRAFANA_URL is set but GRAFANA_TOKEN is not.")
    return problems
