# Configuration reference

`config.py` is the single place that resolves configuration, from three layers
in order of precedence:

1. **Environment variables** — `.env.example` documents every one. Load them
   however you like: a `.env` sourced into the shell, systemd's
   `EnvironmentFile=`, or real exported variables.
2. **`config.json`** — written by the browser setup wizard (`/setup`). Path from
   `CONFIG_FILE`; default `./config.json`, or
   `/etc/homelab-galaxy-dashboard/config.json` when that exists (the installer
   sets it). Same keys as the environment, lower case, grouped by section
   (the section ids and keys are the `SECTIONS` table in `config.py`):

   ```json
   {"pve": [{"name": "pve1", "url": "https://10.0.0.10:8006", "token": "..."}],
    "pve_settings": {"verify_tls": false},
    "zabbix": {"url": "", "user": "", "pass": ""},
    "ui": {"brand": "GALAXY", "domain": "", "wan_label": "ISP",
           "node_accents": {"pve1": "#5ad7ff"}, "palette": {}, "categories": {"ai": ["ollama", "immich"]}},
    "features": {"doom": true, "lights": false}}
   ```

   A list section (`pve`, `ollama`, `svc`, `fleet`, `gpux`, `aisrv`) is a JSON
   array; its section-level fields live under `<id>_settings`. The file may
   hold credentials, so the wizard writes it mode `0600`.
3. **Defaults** in the `SECTIONS` table.

```bash
cp .env.example .env
$EDITOR .env
set -a; . ./.env; set +a
python3 app.py
```

Three start-up outcomes:

| State | What happens |
|---|---|
| Nothing configured | The app starts, prints `[setup] token: ...`, and `/` redirects to `/setup`. No pollers run until something is saved and applied. |
| Partially configured (e.g. `ZBX_URL` without `ZBX_PASS`) | Prints exactly what is wrong and exits non-zero rather than starting into a half-broken scene. |
| `DEMO=1` | Serves everything from `demo/fixtures/`; no validation, no pollers, no network. |

Variables marked **reserved** below are read by `config.py` but not yet applied
by the pollers; the tables state the actual current behaviour in each case.

## The setup wizard

`GET /setup` renders the page; `/api/setup/*` is the API it uses
(`schema`, `config`, `test`, `apply` — see `docs/contracts.md`). Every API call
carries `X-Setup-Token`:

- `SETUP_TOKEN` if set; otherwise generated at first start, printed on the
  console and stored next to `config.json` as `setup-token` (`0600`). Under
  systemd: `journalctl -u homelab-dashboard | grep '\[setup\] token'`.
- `SETUP_UI=false` disables both the page and the API.

The wizard shows which values come from the environment (those win and cannot
be changed from the browser). **Save** writes `config.json`; **Apply**
re-executes the process (`os.execv`, same PID) so the pollers start with the
new configuration. Connection tests actually try the backend (Proxmox
`/api2/json/version` + node list, Zabbix `apiinfo.version` + login + host
count, UniFi login + client count, Frigate `/api/stats`, Ollama `/api/tags`,
Prometheus `/-/ready`, Emby `/System/Info`, a plain GET for the rest) and
never log the credential.

## Indexed lists

Anything that can occur more than once is declared with contiguous indexed
variables starting at `0`. Resolution stops at the first gap, so numbering must
not skip:

```ini
SVC_0_NAME=grafana
SVC_0_CATEGORY=monitor
SVC_0_URL=http://10.0.0.50:3000/api/health

SVC_1_NAME=jellyfin
SVC_1_CATEGORY=media
SVC_1_URL=http://10.0.0.80:8096/System/Info/Public
```

An indexed list set in the environment replaces the whole list from
`config.json` (lists are not merged item by item).

## Reference

### Modes and files

| Variable | Default | Meaning |
|---|---|---|
| `DEMO` | `false` | Fixture mode. Skips validation and pollers; every route answers from `demo/fixtures/`. |
| `DEMO_ADDONS` | `false` | Load `addons/` in demo mode too. |
| `SETUP_UI` | `true` | Serve `/setup` and `/api/setup/*`. |
| `SETUP_TOKEN` | *generated* | Gate for the setup API. |
| `CONFIG_FILE` | `./config.json` | The wizard's file (`/etc/homelab-galaxy-dashboard/config.json` when that exists). |
| `DATA_DIR` | cwd | History DB, `.mode.json` (display mode), `.inventory.json` (last-good node discovery). |

### Brand & screens

| Variable | Default | Meaning |
|---|---|---|
| `BRAND` | `GALAXY` | Big word on both screens. |
| `DOMAIN` | *empty* | Printed under the brand. |
| `TAGLINE` | `live topology · flows · telemetry` | |
| `WAN_LABEL` | `ISP` | Internet-edge label when UniFi reports no ISP name. |
| `UI_PALETTE` | `{}` | JSON: colour per category, merged over the defaults (`ai media network monitor web infra stopped`). |
| `UI_CATEGORIES` | `{}` | JSON: guest-name keywords per category, merged over the defaults. New keys add categories. |
| `UI_NODE_ACCENTS` | `{}` | JSON: galaxy colour per node name. Unset nodes get cyan, amber, violet, green, rose, gold by index. |
| `UI_NODE_LABELS` | `{}` | JSON: label per node name (default: the name, upper-cased). |

### Proxmox — required

| Variable | Default | Meaning |
|---|---|---|
| `PVE_<n>_NAME` | — | Node name as Proxmox knows it. Every endpoint is also asked `/api2/json/nodes`, so a clustered endpoint contributes all its nodes and a typo here is logged. |
| `PVE_<n>_URL` | — | e.g. `https://10.0.0.10:8006` |
| `PVE_<n>_TOKEN` | — | `user@realm!tokenid=secret` |
| `PVE_<n>_LABEL` / `PVE_<n>_ACCENT` | — | Per-node label / colour (also `UI_NODE_*`). |
| `PVE_VERIFY_TLS` | `false` | **Reserved — not yet applied.** All backend requests skip TLS verification. |

### Zabbix / UniFi / Frigate / Grafana / Prometheus

| Variable | Default | Meaning |
|---|---|---|
| `ZBX_URL`, `ZBX_USER`, `ZBX_PASS` | *unset* | Full path to `api_jsonrpc.php`; user/pass required if the URL is set. |
| `UNIFI_URL`, `UNIFI_USER`, `UNIFI_PASS` | *unset* | Controller base URL; a local read-only account. |
| `UNIFI_SITE` | `default` | Site id used in every controller path. |
| `FRIGATE_URL` | *unset* | NVR base URL. Enables camera satellites, `/cam/<name>.jpg`, the showtime detector panel and `features.cameras`. |
| `NP_NVR_IP` | *empty* | A camera NVR on another site, drawn as an external topology node. |
| `GRAFANA_URL` / `GRAFANA_TOKEN` | *unset* | Up/down plus dashboard count. |
| `PROM_URL` | *unset* | Prometheus base URL: node-exporter temperatures, the telemetry panel, `/api/prom`. |

### Ollama

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_<n>_NAME` / `OLLAMA_<n>_URL` | — | Indexed instances for the showtime panel (loaded models, VRAM, busy). |
| `OLLAMA_<n>_GPUS` | *empty* | Local NVML GPU indexes the instance runs on, comma separated. |
| `OLLAMA_<n>_LABEL` | *empty* | GPU label printed next to it. |
| `OLLAMA_URL` | first instance | The chat relay's Ollama (`/api/chat`). |
| `OLLAMA_MODEL` | `qwen2.5:7b` | Model name sent to `/api/generate`. |

### Topology & probing

| Variable | Default | Meaning |
|---|---|---|
| `NETMAP_URL` | *unset* | External SNMP topology JSON (LibreNMS). See `data-sources.md`. |
| `NTOPNG_URL`, `NTOPNG_USER`, `NTOPNG_PASS` | *unset* / `admin` | ntopng for flow arcs; password required if the URL is set. |
| `NTOPNG_IFNAME` | `vmbr0` | Capture interface resolved to an ntopng interface id. |
| `NTOPNG_IFID` | `0` | Fallback id when the name cannot be resolved (`0` = none). |
| `ENABLE_PROBE` | `false` | fping RTT/jitter/loss per node plus a subnet sweep for hosts nothing else lists. Needs `fping`. |
| `NP_CERT_HOSTS` | *empty* | Comma-separated `host[:port]` list for TLS expiry. |
| `TOPOLOGY_CLIENT_OVERRIDES` | `[]` | JSON list of `{"mac", "alt_macs": [], "ip", "cat", "label"}`. `alt_macs` merge a multi-NIC machine into one node. |
| `TOPOLOGY_ALIASES` | `{}` | JSON: UniFi device name → what the screens print. |
| `TOPOLOGY_CLIENT_CAP` | `120` | Anonymous idle wireless clients beyond the busiest N may be dropped. Named/wired clients never are. |

### The internet edge, security, audience

| Variable | Default | Meaning |
|---|---|---|
| `CLOUDFLARED_METRICS_URL` | *unset* | cloudflared's Prometheus endpoint → `edge.cloudflare`. |
| `CROWDSEC_EXPORT_URL` | *unset* | Base URL of `alerts.json` / `decisions.json` (`deploy/edge/`) → `edge.crowdsec` and the threat timeline. |
| `AKVORADO_URL` | *unset* | Akvorado console → `external`. |
| `SECMON_URL` | *unset* | A findings API → `edge.secmon` and the threat level. |
| `SECMON_TZ` | `UTC` | IANA zone for naive timestamps in its findings. |
| `CF_API_TOKEN`, `CF_ZONE_ID` | *unset* | Cloudflare zone analytics (real unique visitors) → `edge.audience`. Both required together. |
| `AUDIENCE_URL` | *unset* | `audience.json` from the origin log exporter; the fallback when the GraphQL path fails, or the only source without a token. |
| `EMBY_URL`, `EMBY_API_KEY` | *unset* | Emby or Jellyfin sessions → `showtime.emby`. |

### Lights, presence, alert mode, features

| Variable | Default | Meaning |
|---|---|---|
| `ENABLE_LIGHTS` | `false` | `features.lights`; the driver in `deploy/lights/` follows `/api/lightstate`. |
| `LIGHTS_STALE_S` | `45` | `/api/lightstate` reports `stale: true` after this long without a POST. |
| `PRESENCE_GRACE_S` | `900` | One positive `/api/presence` report keeps the screens awake this long. |
| `PRESENCE_STALE_S` | `600` | An "inactive" report older than this is ignored (fails open). |
| `ALERT_SEV` | `3` | Zabbix severity at or above which a *new* problem enters alert mode. |
| `ALERT_IGNORE` | `^High CPU` | Regex of problem names that mean busy, not broken. |
| `ENABLE_NEXUS` | `true` | `features.nexus`. |
| `ENABLE_DOOM` | `true` | `features.doom` — true only when `static/doom/js-dos.js` also exists. |
| `ENABLE_CAMERAS` | `true` | `features.cameras` — true only with a Frigate URL. |
| `ENABLE_THREATS` | `true` | `features.threats` — true only with a CrowdSec export or Security Monitor. |

### Lists

| Prefix | Fields | Purpose |
|---|---|---|
| `PVE_<n>_` | `NAME`, `URL`, `TOKEN`, `LABEL`, `ACCENT` | Proxmox endpoints (max 64) |
| `OLLAMA_<n>_` | `NAME`, `URL`, `GPUS`, `LABEL` | Ollama instances |
| `SVC_<n>_` | `NAME`, `CATEGORY`, `URL`, `GUEST` | Service health pips. `GUEST` = exact guest name whose live IP replaces the URL host. |
| `FLEET_<n>_` | `NAME`, `HOST`, `PORT` | TCP reachability checks |
| `GPUX_<n>_` | `NAME`, `URL` | Remote `nvidia_gpu_exporter` endpoints |
| `AISRV_<n>_` | `NAME`, `IP` | Hosts shown with Ollama + node_exporter readouts (guests matching `AI_MARKERS` are discovered too) |

`FLEET_STATS_URL` is a single optional JSON endpoint whose top-level keys are
rendered as rows in the fleet panel. `ADDONS_DIR` points the add-on loader at
another directory (default `addons/`; see `addons/README.md`).

### Local behaviour

| Variable | Default | Meaning |
|---|---|---|
| `LISTEN_HOST` | `0.0.0.0` | Bind address. Set to `127.0.0.1` if a reverse proxy fronts it. |
| `LISTEN_PORT` | `8080` | |
| `POLL_INTERVAL` | `20` | **Reserved — not yet applied.** Each poller uses its own fixed cadence. |
| `METRICS_DB` | `<DATA_DIR>/metrics.db` | SQLite history store path. |
| `HISTORY_DAYS` | `7` | Retention window for sampled history rows. |
| `ENABLE_GPU` | `true` | NVML telemetry. Set `false` on a host with no NVIDIA GPU. |
| `ENABLE_GPU_RENDER` | `false` | Offscreen EGL render to `static/gpu_scene.png`; needs `moderngl`, `numpy`, `Pillow`. Pauses when `/api/presence` says the room is empty. |

Booleans accept `1`, `true`, `yes`, `on` (case-insensitive); anything else is false.

## Tuning the guest categories

Planet colour comes from substring-matching a guest's name against the
category keyword table (`DEFAULT_CATEGORIES` in `config.py`). Override or
extend it without touching code — `config.json`:

```json
{"ui": {"categories": {"media": ["jellyfin", "plex", "sonarr"], "lab": ["bench", "ci-"]},
        "palette": {"lab": "#f5d90a"}}}
```

A category listed there replaces the default keyword list for that category; a
new name appends a category (give it a palette colour too). Unmatched guests
fall back to `infra`, so a guest is never dropped from the scene just because
it is unrecognised.

## Security

- Nothing here is logged. Pollers print the *name* of a failing backend and the
  exception, never the credential; the wizard's connection tests do the same.
- Keep `.env` at mode `0600` and owned by the service account. `config.json`
  is written `0600` by the wizard. The installer in `deploy/` sets both up.
- Prefer a dedicated read-only account per backend over reusing an admin login.
- `/api/config` never contains a credential; `/api/setup/config` masks them.
- The dashboard itself has **no authentication** beyond the setup token. Front
  it with your reverse proxy or SSO; do not expose it to the internet.
