"""Central configuration for the Galaxy dashboard.

Everything that is specific to *your* homelab lives here. Nothing site-specific
is baked into the application code: every address, name, token and feature flag
is resolved from three layers, highest precedence first:

1. **Environment variables** (see ``.env.example``) — the classic way, and what
   the systemd unit loads from its ``EnvironmentFile``.
2. **``config.json``** — written by the browser setup wizard (``/setup``). Path
   from ``CONFIG_FILE``; default ``./config.json``, or
   ``/etc/homelab-galaxy-dashboard/config.json`` when installed by ``deploy/``.
   Same keys as the environment, lower case, grouped by section (the section
   ids and keys are the ``SECTIONS`` table below).
3. **Defaults** in the ``SECTIONS`` table.

Two kinds of settings:

* **Endpoints** — where a data source lives (``ZBX_URL``, ``UNIFI_URL``, ...).
  Unset endpoints are simply skipped: the matching poller no-ops and the
  dashboard renders without that layer. You can run this with only Proxmox
  configured and still get a galaxy.
* **Credentials** — never logged, never sent to the browser. ``config.json`` may
  hold them, so the wizard writes it mode ``0600``.

Lists (Proxmox nodes, Ollama instances, service probes, ...) are declared with
indexed environment variables so an arbitrary number can be declared without
editing code, or as JSON arrays in ``config.json``::

    PVE_0_NAME=pve1
    PVE_0_URL=https://10.0.0.10:8006
    PVE_0_TOKEN=dashboard@pve!readonly=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    PVE_1_NAME=pve2
    ...

``SECTIONS`` is also what the setup wizard renders (label, help, type, whether
a value is a secret), so the field list lives in exactly one place.
"""
import json
import os

# ---------------------------------------------------------------------------
# Bootstrap: where config.json lives, and its raw contents
# ---------------------------------------------------------------------------


def _env(name, default=""):
    return os.environ.get(name, default).strip()


_INSTALLED_CONFIG = "/etc/homelab-galaxy-dashboard/config.json"
CONFIG_FILE = _env("CONFIG_FILE") or (
    _INSTALLED_CONFIG if os.path.exists(_INSTALLED_CONFIG) else os.path.join(os.getcwd(), "config.json")
)


def load_json_config(path=None):
    """The raw ``config.json`` as a dict (``{}`` when absent or unreadable)."""
    path = path or CONFIG_FILE
    try:
        with open(path) as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception as e:  # a corrupt file must not stop the app: the wizard can rewrite it
        print(f"[config] {path}: unreadable ({e}); ignoring it", flush=True)
        return {}


_JSON = load_json_config()

# ---------------------------------------------------------------------------
# The schema. One entry per setting: env name, config.json key, type, default.
# ---------------------------------------------------------------------------


def F(env, key, label, type="text", default="", help="", secret=False, required=False,
      placeholder="", options=None, env_only=False):
    """One setting. ``type`` is text | url | password | int | bool | json | csv | select."""
    return {"env": env, "key": key, "label": label, "type": "password" if secret else type,
            "default": default, "help": help, "secret": secret, "required": required,
            "placeholder": placeholder, "options": options or [], "env_only": env_only}


CATEGORY_NAMES = ["ai", "media", "network", "monitor", "web", "infra"]

# Guest-name keywords -> category. Extend or override per category with
# ``ui.categories`` in config.json (or UI_CATEGORIES as a JSON string); a
# category listed there is merged over this default, and a new category name
# is appended. Unmatched guests are "infra", so nothing is ever dropped.
DEFAULT_CATEGORIES = {
    "ai": ["ollama", "llm", "openwebui", "comfy", "stable", "whisper", "qdrant", "chroma", "immich", "frigate",
           "brain", "agent", "vllm", "localai"],
    "media": ["emby", "jellyfin", "plex", "tdarr", "threadfin", "sonarr", "radarr", "lidarr", "bazarr",
              "prowlarr", "transmission", "qbit", "sabnzbd", "nextpvr", "navidrome", "audiobook", "tubearchiv"],
    "network": ["pihole", "adguard", "technitium", "dns", "unbound", "nginx", "npm", "traefik", "caddy",
                "cloudflar", "wireguard", "freeradius", "openldap", "ldap", "guacamole", "omada", "unifi", "traccar"],
    "monitor": ["zabbix", "grafana", "prometheus", "loki", "influx", "checkmk", "librenms", "netdata", "uptime",
                "monitor", "speedtest", "ntopng", "cockpit", "noc", "gatus", "akvorado"],
    "web": ["dashboard", "dashy", "homarr", "homepage", "heimdall", "wiki", "bookstack", "mail", "portal", "vault",
            "nextcloud", "paperless", "actual", "stirling", "gitea", "forgejo", "homeassist", "obsidian", "affine"],
    "infra": ["docker", "podman", "k3s", "backup", "pbs", "borg", "restic", "proxmox", "iventoy", "minio", "nfs",
              "samba", "postgres", "mysql", "mariadb", "redis", "runner", "worker", "scheduler", "proxy", "security"],
}

DEFAULT_PALETTE = {"ai": "#ff4fa3", "media": "#38e1ff", "network": "#37f5a0", "monitor": "#ffb347",
                   "web": "#9b8cff", "infra": "#8fb0d0", "stopped": "#ff5a6a"}

# Node accents by index when none is configured: cyan, amber, violet, green, rose, gold.
NODE_ACCENTS_DEFAULT = ["#5ad7ff", "#ffb347", "#9b8cff", "#37f5a0", "#ff4fa3", "#ffd166"]

SECTIONS = [
    {"id": "ui", "title": "Brand & screens", "help": "What the wall and the /nexus screen print.",
     "fields": [
         F("BRAND", "brand", "Brand", default="GALAXY", help="Big word on both screens."),
         F("DOMAIN", "domain", "Domain", placeholder="example.com", help="Printed under the brand; purely cosmetic."),
         F("TAGLINE", "tagline", "Tagline", default="live topology · flows · telemetry"),
         F("WAN_LABEL", "wan_label", "WAN label", default="ISP",
           help="Name of the internet edge when UniFi does not report an ISP name."),
         F("UI_PALETTE", "palette", "Category palette", type="json", default={},
           help="Override colours per category, e.g. {\"ai\": \"#ff4fa3\"}."),
         F("UI_CATEGORIES", "categories", "Category keywords", type="json", default={},
           help="Guest-name keywords per category, merged over the defaults, e.g. {\"ai\": [\"ollama\", \"immich\"]}."),
         F("UI_NODE_ACCENTS", "node_accents", "Node accents", type="json", default={},
           help="Galaxy colour per Proxmox node name, e.g. {\"pve1\": \"#5ad7ff\"}. Defaults to a palette by index."),
         F("UI_NODE_LABELS", "node_labels", "Node labels", type="json", default={},
           help="What the screens print per node name, e.g. {\"pve1\": \"RACK\"}. Defaults to the node name."),
     ]},
    {"id": "pve", "title": "Proxmox nodes", "test": True, "list": True, "prefix": "PVE",
     "help": "Required. One entry per Proxmox endpoint; a clustered endpoint contributes every node it reports. "
             "Use a read-only API token (PVEAuditor on /), never a root password.",
     "item_fields": [
         F("NAME", "name", "Node name", required=True, placeholder="pve1",
           help="The node name as Proxmox knows it (interpolated into /nodes/<name>/...)."),
         F("URL", "url", "API URL", type="url", required=True, placeholder="https://10.0.0.10:8006"),
         F("TOKEN", "token", "API token", secret=True, required=True,
           placeholder="dashboard@pve!readonly=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"),
         F("LABEL", "label", "Label", help="Shown on screen instead of the node name."),
         F("ACCENT", "accent", "Accent", placeholder="#5ad7ff", help="Galaxy colour (hex)."),
     ],
     "fields": [
         F("PVE_VERIFY_TLS", "verify_tls", "Verify TLS", type="bool", default=False,
           help="Reserved: all backend requests currently skip TLS verification (self-signed certificates work)."),
     ]},
    {"id": "zabbix", "title": "Zabbix", "test": True, "help": "Host counts, problems, per-host severity flares.",
     "fields": [
         F("ZBX_URL", "url", "API URL", type="url", placeholder="http://10.0.0.20/zabbix/api_jsonrpc.php"),
         F("ZBX_USER", "user", "User", placeholder="dashboard"),
         F("ZBX_PASS", "pass", "Password", secret=True),
     ]},
    {"id": "unifi", "title": "UniFi", "test": True,
     "help": "Client count, device tree, WAN throughput; the physical topology comes from here.",
     "fields": [
         F("UNIFI_URL", "url", "Controller URL", type="url", placeholder="https://10.0.0.1"),
         F("UNIFI_USER", "user", "User", placeholder="dashboard", help="A local read-only account, not SSO."),
         F("UNIFI_PASS", "pass", "Password", secret=True),
         F("UNIFI_SITE", "site", "Site", default="default"),
     ]},
    {"id": "frigate", "title": "Frigate", "test": True, "help": "NVR: camera satellites, detector stats, recent events.",
     "fields": [
         F("FRIGATE_URL", "url", "Frigate URL", type="url", placeholder="http://10.0.0.30:5000"),
         F("NP_NVR_IP", "nvr_ip", "Remote NVR address", placeholder="10.0.0.200",
           help="Optional: address of a camera NVR on another site, drawn as an external node."),
     ]},
    {"id": "ollama", "title": "Ollama instances", "test": True, "list": True, "prefix": "OLLAMA",
     "help": "Each instance is polled for loaded models and VRAM; the first one also backs the chat box.",
     "item_fields": [
         F("NAME", "name", "Name", required=True, placeholder="chat"),
         F("URL", "url", "URL", type="url", required=True, placeholder="http://10.0.0.40:11434"),
         F("GPUS", "gpus", "GPU indexes", type="csv", placeholder="0,1",
           help="Local NVML GPU indexes this instance runs on (for the showtime panel)."),
         F("LABEL", "label", "GPU label", placeholder="RTX 3080 Ti"),
     ],
     "fields": [
         F("OLLAMA_URL", "chat_url", "Chat relay URL", type="url",
           help="Ollama used by /api/chat. Defaults to the first instance above."),
         F("OLLAMA_MODEL", "model", "Chat model", default="qwen2.5:7b"),
     ]},
    {"id": "grafana", "title": "Grafana", "test": True, "help": "Up/down plus dashboard count in the sources panel.",
     "fields": [
         F("GRAFANA_URL", "url", "Grafana URL", type="url", placeholder="http://10.0.0.50:3000"),
         F("GRAFANA_TOKEN", "token", "Service-account token", secret=True),
     ]},
    {"id": "prometheus", "title": "Prometheus", "test": True,
     "help": "Node-exporter temperatures, plus the telemetry panel (IPMI, SMART, ZFS, PBS, UniFi poller, CrowdSec, "
             "Akvorado exporters — whatever your Prometheus scrapes).",
     "fields": [
         F("PROM_URL", "url", "Prometheus URL", type="url", placeholder="http://10.0.0.51:9090"),
     ]},
    {"id": "ntopng", "title": "ntopng", "test": True, "help": "Host-to-host flows drawn as packet arcs.",
     "fields": [
         F("NTOPNG_URL", "url", "ntopng URL", type="url", placeholder="http://10.0.0.10:3001"),
         F("NTOPNG_USER", "user", "User", default="admin"),
         F("NTOPNG_PASS", "pass", "Password", secret=True),
         F("NTOPNG_IFNAME", "ifname", "Capture interface", default="vmbr0"),
         F("NTOPNG_IFID", "ifid", "Interface id fallback", type="int", default=0,
           help="Used only when the interface name cannot be resolved (0 = none)."),
     ]},
    {"id": "netmap", "title": "LibreNMS netmap", "test": True,
     "help": "A JSON document listing SNMP devices (see docs/data-sources.md).",
     "fields": [F("NETMAP_URL", "url", "Netmap JSON URL", type="url", placeholder="http://10.0.0.60/netmap.json")]},
    {"id": "cloudflared", "title": "cloudflared metrics", "test": True,
     "help": "The tunnel's Prometheus endpoint (cloudflared --metrics): requests/min, edge locations, HA connections.",
     "fields": [F("CLOUDFLARED_METRICS_URL", "url", "Metrics URL", type="url",
                  placeholder="http://10.0.0.36:20241/metrics")]},
    {"id": "crowdsec", "title": "CrowdSec export", "test": True,
     "help": "Directory URL serving alerts.json / decisions.json written by deploy/edge/galaxy-cs-export.sh.",
     "fields": [F("CROWDSEC_EXPORT_URL", "url", "Export base URL", type="url",
                  placeholder="http://10.0.0.36:8099/_cs")]},
    {"id": "akvorado", "title": "Akvorado", "test": True,
     "help": "Flow collector console API: top external destinations, countries, ASNs.",
     "fields": [F("AKVORADO_URL", "url", "Console URL", type="url", placeholder="http://10.0.0.61:8080")]},
    {"id": "secmon", "title": "Security Monitor", "test": True,
     "help": "A findings API (/api/stats/summary + /api/findings) feeding the threat level and the timeline.",
     "fields": [
         F("SECMON_URL", "url", "Security Monitor URL", type="url", placeholder="http://10.0.0.62:8765"),
         F("SECMON_TZ", "tz", "Timestamp timezone", default="UTC",
           help="IANA zone for naive timestamps in its findings, e.g. Europe/Berlin."),
     ]},
    {"id": "cloudflare", "title": "Cloudflare analytics", "test": True,
     "help": "Real unique visitors from the zone's GraphQL analytics (token needs Analytics:Read).",
     "fields": [
         F("CF_API_TOKEN", "token", "API token", secret=True),
         F("CF_ZONE_ID", "zone_id", "Zone id"),
     ]},
    {"id": "audience", "title": "Audience export", "test": True,
     "help": "Fallback viewer count from your origin's nginx log (deploy/edge/galaxy-audience-export.py).",
     "fields": [F("AUDIENCE_URL", "url", "audience.json URL", type="url",
                  placeholder="http://10.0.0.36:8099/_cs/audience.json")]},
    {"id": "emby", "title": "Emby / Jellyfin", "test": True, "help": "Active sessions and what is playing.",
     "fields": [
         F("EMBY_URL", "url", "Server URL", type="url", placeholder="http://10.0.0.80:8096"),
         F("EMBY_API_KEY", "api_key", "API key", secret=True),
     ]},
    {"id": "lights", "title": "Lights",
     "help": "The room-lights driver (deploy/lights/) follows /api/lightstate; enable to show the lights chip.",
     "fields": [
         F("ENABLE_LIGHTS", "enabled", "Room lights follow the screens", type="bool", default=False),
         F("LIGHTS_STALE_S", "stale_s", "Stale after (s)", type="int", default=45,
           help="A screen that has not published a colour for this long is reported as stale."),
     ]},
    {"id": "presence", "title": "Presence & alert mode",
     "help": "POST /api/presence from a motion sensor pauses rendering in an empty room; alert mode flips on new problems.",
     "fields": [
         F("PRESENCE_GRACE_S", "grace_s", "Grace window (s)", type="int", default=900,
           help="How long one motion report keeps the screens awake."),
         F("PRESENCE_STALE_S", "stale_s", "Stale after (s)", type="int", default=600,
           help="An 'empty' report older than this is ignored (fails open)."),
         F("ALERT_SEV", "alert_sev", "Alert severity", type="int", default=3,
           help="Zabbix severity (0-5) at or above which a NEW problem enters alert mode."),
         F("ALERT_IGNORE", "alert_ignore", "Ignore pattern", default="^High CPU",
           help="Regex of problem names that mean busy, not broken."),
     ]},
    {"id": "features", "title": "Features",
     "fields": [
         F("ENABLE_NEXUS", "nexus", "Nexus (second screen)", type="bool", default=True),
         F("ENABLE_DOOM", "doom", "DOOM takeover", type="bool", default=True,
           help="Also needs static/doom/js-dos.js (tools/fetch-doom.sh)."),
         F("ENABLE_CAMERAS", "cameras", "Camera satellites", type="bool", default=True,
           help="Needs a Frigate URL."),
         F("ENABLE_THREATS", "threats", "Threat feed", type="bool", default=True),
     ]},
    {"id": "advanced", "title": "Advanced",
     "fields": [
         F("LISTEN_HOST", "listen_host", "Bind address", default="0.0.0.0"),
         F("LISTEN_PORT", "listen_port", "Port", type="int", default=8080),
         F("DATA_DIR", "data_dir", "Data directory", default="",
           help="History DB, display-mode file, inventory cache. Default: the working directory."),
         F("METRICS_DB", "metrics_db", "History database", placeholder="metrics.db",
           help="SQLite path; default <DATA_DIR>/metrics.db."),
         F("HISTORY_DAYS", "history_days", "History retention (days)", type="int", default=7),
         F("POLL_INTERVAL", "poll_interval", "Poll interval (s)", type="int", default=20,
           help="Reserved: pollers currently use fixed cadences."),
         F("ENABLE_GPU", "gpu", "Local NVIDIA telemetry", type="bool", default=True),
         F("ENABLE_GPU_RENDER", "gpu_render", "Server-side EGL render", type="bool", default=False),
         F("ENABLE_PROBE", "probe", "Active ICMP probing", type="bool", default=False,
           help="fping RTT/jitter/loss per node plus a subnet sweep for unknown hosts. Needs fping."),
         F("NP_CERT_HOSTS", "cert_hosts", "TLS hosts to watch", type="csv", default=[],
           placeholder="example.com,mail.example.com:993"),
         F("SETUP_UI", "setup_ui", "Setup wizard enabled", type="bool", default=True),
     ]},
    # Lists and tuning that the wizard does not render as forms (hidden): still
    # layered env > config.json > default like everything else.
    {"id": "svc", "title": "Service health probes", "list": True, "prefix": "SVC", "hidden": True,
     "help": "HTTP endpoints shown as status pips. GUEST resolves the address from the live guest inventory.",
     "item_fields": [
         F("NAME", "name", "Name", required=True), F("CATEGORY", "category", "Category", default="infra"),
         F("URL", "url", "URL", type="url", required=True),
         F("GUEST", "guest", "Guest name", help="Exact guest name whose current IP replaces the URL host."),
     ]},
    {"id": "fleet", "title": "Fleet reachability", "list": True, "prefix": "FLEET", "hidden": True,
     "item_fields": [F("NAME", "name", "Name", required=True), F("HOST", "host", "Host", required=True),
                     F("PORT", "port", "Port", type="int", default=22)],
     "fields": [F("FLEET_STATS_URL", "stats_url", "Stats JSON URL", type="url")]},
    {"id": "gpux", "title": "Remote GPU exporters", "list": True, "prefix": "GPUX", "hidden": True,
     "item_fields": [F("NAME", "name", "Host", required=True), F("URL", "url", "Metrics URL", type="url", required=True)]},
    {"id": "aisrv", "title": "AI servers", "list": True, "prefix": "AISRV", "hidden": True,
     "help": "Hosts shown with an Ollama + node_exporter readout. Guests named like an inference host are discovered too.",
     "item_fields": [F("NAME", "name", "Name", required=True), F("IP", "ip", "Address", required=True)],
     "fields": [
         F("AI_MARKERS", "markers", "Discovery keywords", type="csv",
           default=["ollama", "vllm", "localai", "llamacpp", "llama-cpp", "text-generation", "tabbyapi"]),
         F("AI_OLLAMA_PORT", "ollama_port", "Ollama port", type="int", default=11434),
         F("AI_NODE_PORT", "node_port", "node_exporter port", type="int", default=9100),
     ]},
    {"id": "topology", "title": "Topology tuning", "hidden": True,
     "fields": [
         F("TOPOLOGY_CLIENT_OVERRIDES", "client_overrides", "Client overrides", type="json", default=[],
           help="[{\"mac\": \"aa:bb:cc:dd:ee:ff\", \"alt_macs\": [], \"ip\": \"\", \"cat\": \"pc\", \"label\": \"Desktop\"}]. "
                "alt_macs merge a multi-NIC machine into one node."),
         F("TOPOLOGY_ALIASES", "aliases", "Device name aliases", type="json", default={},
           help="UniFi device name -> what the screens print."),
         F("TOPOLOGY_CLIENT_CAP", "client_cap", "Anonymous client cap", type="int", default=120),
     ]},
    {"id": "addons", "title": "Add-ons", "hidden": True,
     "fields": [
         F("ADDONS_DIR", "dir", "Add-ons directory", default="",
           help="Default: the addons/ folder next to app.py."),
         F("DEMO_ADDONS", "demo", "Load add-ons in demo mode", type="bool", default=False),
     ]},
]

_FIELDS = {}          # env name -> (section, field)
for _s in SECTIONS:
    for _f in _s.get("fields", []):
        _FIELDS[_f["env"]] = (_s, _f)


def _coerce(value, ftype, default):
    """Turn an env string or a JSON value into the field's type."""
    if value is None:
        return default
    if ftype == "bool":
        if isinstance(value, bool):
            return value
        v = str(value).strip().lower()
        return default if not v else v in ("1", "true", "yes", "on")
    if ftype == "int":
        try:
            return int(str(value).strip() or default)
        except (TypeError, ValueError):
            return default
    if ftype == "csv":
        if isinstance(value, list):
            return [str(x).strip() for x in value if str(x).strip()]
        return [x.strip() for x in str(value).split(",") if x.strip()]
    if ftype == "json":
        if isinstance(value, (dict, list)):
            return value
        v = str(value).strip()
        if not v:
            return default
        try:
            return json.loads(v)
        except ValueError:
            print(f"[config] ignoring unparseable JSON value ({v[:40]}...)", flush=True)
            return default
    return str(value).strip() if not isinstance(value, str) else value.strip()


def get(env):
    """Resolve one setting: environment > config.json > default."""
    section, field = _FIELDS[env]
    raw = os.environ.get(env)
    if raw is not None and raw.strip() != "":
        return _coerce(raw, field["type"], field["default"])
    if not field["env_only"]:
        sec = json_section(section["id"])
        if field["key"] in sec and sec[field["key"]] not in (None, ""):
            return _coerce(sec[field["key"]], field["type"], field["default"])
    return field["default"]


def json_section(section_id):
    """The config.json dict for a section. A list section (``"pve": [...]``)
    keeps its section-level fields under ``"<id>_settings"``."""
    section = next(s for s in SECTIONS if s["id"] == section_id)
    raw = _JSON.get(section_id + "_settings") if section.get("list") else _JSON.get(section_id)
    return raw if isinstance(raw, dict) else {}


def from_env(env):
    """True when the environment (not config.json) supplies this value."""
    return bool(os.environ.get(env, "").strip())


def _indexed(prefix, fields, limit=64):
    """Collect ``PREFIX_<n>_<FIELD>`` env vars into a list of dicts.

    Stops at the first index with no value for the first field, so the numbering
    must be contiguous from 0. Returns ``[]`` when nothing is configured.
    """
    out = []
    for i in range(limit):
        first = _env(f"{prefix}_{i}_{fields[0]['env']}")
        if not first:
            break
        out.append({f["key"]: _coerce(_env(f"{prefix}_{i}_{f['env']}") or None, f["type"], f["default"])
                    for f in fields})
    return out


def get_list(section_id):
    """A list section (Proxmox nodes, ...): env-indexed entries win over config.json."""
    section = next(s for s in SECTIONS if s["id"] == section_id)
    fields = section["item_fields"]
    items = _indexed(section["prefix"], fields)
    if not items:
        raw = _JSON.get(section_id)
        if isinstance(raw, list):
            for it in raw:
                if not isinstance(it, dict):
                    continue
                row = {f["key"]: _coerce(it.get(f["key"]), f["type"], f["default"]) for f in fields}
                if row.get(fields[0]["key"]):
                    items.append(row)
    return items


def list_from_env(section_id):
    section = next(s for s in SECTIONS if s["id"] == section_id)
    return bool(_env(f"{section['prefix']}_0_{section['item_fields'][0]['env']}"))


def _flag(name, default=False):
    v = _env(name)
    return default if not v else v.lower() in ("1", "true", "yes", "on")


# ---------------------------------------------------------------------------
# Process-level switches (environment only)
# ---------------------------------------------------------------------------
DEMO = _flag("DEMO", False)              # serve everything from demo/fixtures; no pollers, no validation
SETUP_TOKEN = _env("SETUP_TOKEN")        # gate for /api/setup/*; generated and printed when unset
VERSION = "2.0.0"

# ---------------------------------------------------------------------------
# Proxmox VE — the backbone. Each node becomes one spiral galaxy in the scene.
# ---------------------------------------------------------------------------
PVE_NODES = [
    {"node": n["name"], "url": n["url"].rstrip("/"), "token": n["token"],
     "label": n.get("label") or "", "accent": n.get("accent") or ""}
    for n in get_list("pve")
]
PVE_VERIFY_TLS = get("PVE_VERIFY_TLS")

# ---------------------------------------------------------------------------
# Optional backends. Each layer is skipped when its URL is unset.
# ---------------------------------------------------------------------------
ZBX_URL, ZBX_USER, ZBX_PASS = get("ZBX_URL"), get("ZBX_USER"), get("ZBX_PASS")
UNIFI_URL, UNIFI_USER, UNIFI_PASS, UNIFI_SITE = get("UNIFI_URL"), get("UNIFI_USER"), get("UNIFI_PASS"), get("UNIFI_SITE")
FRIGATE_URL = get("FRIGATE_URL").rstrip("/")
NVR_IP = get("NP_NVR_IP")
GRAFANA_URL, GRAFANA_TOKEN = get("GRAFANA_URL").rstrip("/"), get("GRAFANA_TOKEN")
PROM_URL = get("PROM_URL").rstrip("/")
NETMAP_URL = get("NETMAP_URL")
NTOPNG_URL, NTOPNG_USER, NTOPNG_PASS = get("NTOPNG_URL").rstrip("/"), get("NTOPNG_USER"), get("NTOPNG_PASS")
NTOPNG_IFNAME, NTOPNG_IFID = get("NTOPNG_IFNAME"), get("NTOPNG_IFID")

# Ollama: an indexed list of instances (showtime panel) plus the chat relay.
OLLAMA_INSTANCES = [
    {"name": o["name"], "url": o["url"].rstrip("/"),
     "gpus": [int(g) for g in (o.get("gpus") or []) if str(g).strip().lstrip("-").isdigit()],
     "label": o.get("label") or ""}
    for o in get_list("ollama")
]
OLLAMA_URL = get("OLLAMA_URL").rstrip("/") or (OLLAMA_INSTANCES[0]["url"] if OLLAMA_INSTANCES else "")
OLLAMA_MODEL = get("OLLAMA_MODEL")

# The outside edge: tunnel metrics, CrowdSec export, flow collector, security findings, audience.
CLOUDFLARED_METRICS_URL = get("CLOUDFLARED_METRICS_URL")
CROWDSEC_EXPORT_URL = get("CROWDSEC_EXPORT_URL").rstrip("/")
AKVORADO_URL = get("AKVORADO_URL").rstrip("/")
SECMON_URL, SECMON_TZ = get("SECMON_URL").rstrip("/"), get("SECMON_TZ")
CF_API_TOKEN, CF_ZONE_ID = get("CF_API_TOKEN"), get("CF_ZONE_ID")
AUDIENCE_URL = get("AUDIENCE_URL")
EMBY_URL, EMBY_API_KEY = get("EMBY_URL").rstrip("/"), get("EMBY_API_KEY")

# Lights, presence, alert mode.
ENABLE_LIGHTS, LIGHTS_STALE_S = get("ENABLE_LIGHTS"), get("LIGHTS_STALE_S")
PRESENCE_GRACE_S, PRESENCE_STALE_S = get("PRESENCE_GRACE_S"), get("PRESENCE_STALE_S")
ALERT_SEV, ALERT_IGNORE = get("ALERT_SEV"), get("ALERT_IGNORE")

# Features.
ENABLE_NEXUS, ENABLE_DOOM = get("ENABLE_NEXUS"), get("ENABLE_DOOM")
ENABLE_CAMERAS, ENABLE_THREATS = get("ENABLE_CAMERAS"), get("ENABLE_THREATS")

# Remote GPU exporters (nvidia_gpu_exporter Prometheus text) on other machines.
REMOTE_GPU_EXPORTERS = [
    {"name": e["name"], "host": e["name"], "url": e["url"], "name_prefix": e["name"]}
    for e in get_list("gpux")
]

# Hosts shown with an Ollama / node_exporter readout; more are discovered from guest names.
AI_MARKERS = [m.lower() for m in get("AI_MARKERS")]
AI_OLLAMA_PORT, AI_NODE_PORT = get("AI_OLLAMA_PORT"), get("AI_NODE_PORT")
AI_SERVERS = [
    {"name": s["name"], "ip": s["ip"],
     "ollama": f"http://{s['ip']}:{AI_OLLAMA_PORT}/api/tags",
     "node": f"http://{s['ip']}:{AI_NODE_PORT}/metrics", "src": "configured"}
    for s in get_list("aisrv")
]

# Service health probes (status pips). GUEST resolves the address live.
SERVICE_PROBES = [
    {"name": s["name"], "cat": s.get("category") or "infra", "url": s["url"], "guest": s.get("guest") or ""}
    for s in get_list("svc")
]

# Fleet: arbitrary host:port reachability checks plus one optional JSON stats endpoint.
FLEET_TARGETS = get_list("fleet")
FLEET_STATS_URL = get("FLEET_STATS_URL")

# Topology tuning.
TOPOLOGY_CLIENT_OVERRIDES = get("TOPOLOGY_CLIENT_OVERRIDES") if isinstance(get("TOPOLOGY_CLIENT_OVERRIDES"), list) else []
TOPOLOGY_ALIASES = get("TOPOLOGY_ALIASES") if isinstance(get("TOPOLOGY_ALIASES"), dict) else {}
TOPOLOGY_CLIENT_CAP = get("TOPOLOGY_CLIENT_CAP")

# Add-ons.
_HERE = os.path.dirname(os.path.abspath(__file__))
ADDONS_DIR = get("ADDONS_DIR") or os.path.join(_HERE, "addons")
DEMO_ADDONS = get("DEMO_ADDONS")

# ---------------------------------------------------------------------------
# Local behaviour
# ---------------------------------------------------------------------------
LISTEN_HOST, LISTEN_PORT = get("LISTEN_HOST"), get("LISTEN_PORT")
DATA_DIR = get("DATA_DIR") or os.getcwd()
METRICS_DB = get("METRICS_DB") or os.path.join(DATA_DIR, "metrics.db")
HISTORY_DAYS, POLL_INTERVAL = get("HISTORY_DAYS"), get("POLL_INTERVAL")
ENABLE_GPU, ENABLE_GPU_RENDER, ENABLE_PROBE = get("ENABLE_GPU"), get("ENABLE_GPU_RENDER"), get("ENABLE_PROBE")
CERT_HOSTS = get("NP_CERT_HOSTS")
SETUP_UI = get("SETUP_UI")
MODE_FILE = os.path.join(DATA_DIR, ".mode.json")            # display mode survives a restart
INVENTORY_CACHE = os.path.join(DATA_DIR, ".inventory.json")  # last-good node discovery

# ---------------------------------------------------------------------------
# Screens: brand, palette, categories, node accents
# ---------------------------------------------------------------------------
BRAND, DOMAIN, TAGLINE, WAN_LABEL = get("BRAND"), get("DOMAIN"), get("TAGLINE"), get("WAN_LABEL")


def _merged_categories():
    cats = {k: list(v) for k, v in DEFAULT_CATEGORIES.items()}
    extra = get("UI_CATEGORIES")
    if isinstance(extra, dict):
        for k, v in extra.items():
            if isinstance(v, list):
                cats[str(k)] = [str(x).lower() for x in v]
    return cats


CATEGORIES = _merged_categories()                         # category -> keywords (ordered)
CATEGORY_LIST = list(CATEGORIES.keys())
PALETTE = dict(DEFAULT_PALETTE)
if isinstance(get("UI_PALETTE"), dict):
    PALETTE.update({str(k): str(v) for k, v in get("UI_PALETTE").items()})
NODE_ACCENTS = get("UI_NODE_ACCENTS") if isinstance(get("UI_NODE_ACCENTS"), dict) else {}
NODE_LABELS = get("UI_NODE_LABELS") if isinstance(get("UI_NODE_LABELS"), dict) else {}


def categorize(name):
    """Guest name -> category, by keyword. Unmatched is "infra": nothing is ever dropped."""
    n = (name or "").lower()
    for cat, keys in CATEGORIES.items():
        if any(k in n for k in keys):
            return cat
    return "infra"


def node_entries(names=None):
    """The ordered node list for /api/config: id, label, accent.

    ``names`` may extend the configured list with nodes discovered from a
    clustered endpoint; accents fall back to a palette by index.
    """
    order = [n["node"] for n in PVE_NODES]
    for nm in names or []:
        if nm and nm not in order:
            order.append(nm)
    by_name = {n["node"]: n for n in PVE_NODES}
    out = []
    for i, nm in enumerate(order):
        cfg = by_name.get(nm, {})
        out.append({"id": nm,
                    "label": str(NODE_LABELS.get(nm) or cfg.get("label") or nm).upper(),
                    "accent": str(NODE_ACCENTS.get(nm) or cfg.get("accent") or NODE_ACCENTS_DEFAULT[i % len(NODE_ACCENTS_DEFAULT)])})
    return out


def is_configured():
    """False when nothing at all is set up: the app then serves the setup wizard."""
    return bool(PVE_NODES)


def missing_required():
    """Return a list of human-readable problems that would stop the app booting."""
    problems = []
    if not PVE_NODES:
        problems.append(
            "No Proxmox nodes configured. Set PVE_0_NAME / PVE_0_URL / PVE_0_TOKEN "
            "(see .env.example) or open /setup. The dashboard needs at least one node to draw."
        )
    for i, n in enumerate(PVE_NODES):
        if not n.get("token"):
            problems.append(f"PVE_{i}_TOKEN is empty for node {n['node']!r}.")
        if not n.get("url"):
            problems.append(f"PVE_{i}_URL is empty for node {n['node']!r}.")
    if ZBX_URL and not (ZBX_USER and ZBX_PASS):
        problems.append("ZBX_URL is set but ZBX_USER / ZBX_PASS are not.")
    if UNIFI_URL and not (UNIFI_USER and UNIFI_PASS):
        problems.append("UNIFI_URL is set but UNIFI_USER / UNIFI_PASS are not.")
    if GRAFANA_URL and not GRAFANA_TOKEN:
        problems.append("GRAFANA_URL is set but GRAFANA_TOKEN is not.")
    if NTOPNG_URL and not NTOPNG_PASS:
        problems.append("NTOPNG_URL is set but NTOPNG_PASS is not.")
    if CF_API_TOKEN and not CF_ZONE_ID:
        problems.append("CF_API_TOKEN is set but CF_ZONE_ID is not.")
    return problems
