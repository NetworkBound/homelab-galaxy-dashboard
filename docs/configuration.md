# Configuration reference

All configuration comes from the environment, and `config.py` is the single
place that resolves it. Variables marked **reserved** below are read by
`config.py` but not yet applied by the pollers; the tables state the actual
current behaviour in each case.

Load it however you like — a `.env` sourced into the shell, systemd's
`EnvironmentFile=`, or real exported variables:

```bash
cp .env.example .env
$EDITOR .env
set -a; . ./.env; set +a
python3 app.py
```

If something required is missing, the app prints exactly what is wrong and exits
non-zero rather than starting into a half-broken scene.

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

## Reference

### Proxmox — required

| Variable | Default | Meaning |
|---|---|---|
| `PVE_<n>_NAME` | — | Node name as Proxmox knows it. Must match the node's own hostname. |
| `PVE_<n>_URL` | — | e.g. `https://10.0.0.10:8006` |
| `PVE_<n>_TOKEN` | — | `user@realm!tokenid=secret` |
| `PVE_VERIFY_TLS` | `false` | **Reserved — not yet applied.** All backend requests are currently made with TLS verification disabled, which accepts Proxmox's self-signed default certificate. Setting this has no effect today. |

### Zabbix

| Variable | Default | Meaning |
|---|---|---|
| `ZBX_URL` | *unset* | Full path to `api_jsonrpc.php`. Unset disables the layer. |
| `ZBX_USER` / `ZBX_PASS` | — | Required if `ZBX_URL` is set. |

### UniFi

| Variable | Default | Meaning |
|---|---|---|
| `UNIFI_URL` | *unset* | Controller base URL. |
| `UNIFI_USER` / `UNIFI_PASS` | — | Required if `UNIFI_URL` is set. Use a local read-only account. |
| `UNIFI_SITE` | `default` | **Reserved — not yet applied.** The poller always queries the `default` site. Multi-site controllers need the site path changed in `app.py`. |

### Optional backends

| Variable | Default | Meaning |
|---|---|---|
| `FRIGATE_URL` | *unset* | NVR base URL. Enables camera satellites and `/cam/<name>.jpg`. |
| `OLLAMA_URL` | *unset* | Enables the in-scene chat box. Unset makes `/api/chat` report chat as disabled. The relay requests the model `qwen2.5:7b` by name; pull that model on the Ollama host or change the string in `app.py`. |
| `GRAFANA_URL` / `GRAFANA_TOKEN` | *unset* | Up/down plus dashboard count. |
| `PROM_URL` | *unset* | Prometheus base URL, used for node-exporter metrics. |
| `NETMAP_URL` | *unset* | External topology JSON. See `data-sources.md`. |
| `NTOPNG_URL` | *unset* | ntopng base URL for flow arcs. |
| `NTOPNG_USER` | `admin` | |
| `NTOPNG_PASS` | *unset* | |
| `NTOPNG_IFNAME` | `vmbr0` | Capture interface to resolve to an ntopng interface id. |
| `NP_CERT_HOSTS` | *empty* | Comma-separated `host[:port]` list for TLS expiry. Hostnames only. |
| `NP_NVR_IP` | *empty* | NVR address, if it is not on the main LAN. |

### Lists

| Prefix | Fields | Purpose |
|---|---|---|
| `PVE_<n>_` | `NAME`, `URL`, `TOKEN` | Proxmox nodes (max 16) |
| `SVC_<n>_` | `NAME`, `CATEGORY`, `URL` | Service health pips (max 64) |
| `FLEET_<n>_` | `NAME`, `HOST`, `PORT` | TCP reachability checks (max 32) |
| `GPUX_<n>_` | `NAME`, `URL` | Remote `nvidia_gpu_exporter` endpoints (max 16) |
| `AISRV_<n>_` | `NAME`, `IP` | Hosts shown with Ollama + node_exporter readouts (max 16) |

`SVC_<n>_CATEGORY` is one of `ai`, `media`, `network`, `monitor`, `web`, `infra`
and controls the pip colour. An unrecognised value falls back to `infra`.

`FLEET_STATS_URL` is a single optional JSON endpoint whose top-level keys are
rendered as rows in the fleet panel.

### Local behaviour

| Variable | Default | Meaning |
|---|---|---|
| `LISTEN_HOST` | `0.0.0.0` | Bind address. Set to `127.0.0.1` if a reverse proxy fronts it. |
| `LISTEN_PORT` | `8080` | |
| `POLL_INTERVAL` | `20` | **Reserved — not yet applied.** Each poller currently uses its own fixed cadence (6–60 s depending on the source; the history sampler runs every 30 s). |
| `METRICS_DB` | `metrics.db` | **Reserved — not yet applied.** The history sampler writes to the fixed path `/opt/dashboard/metrics.db` (`DBPATH` in `app.py`). If that path is not writable, history is disabled and everything else keeps working. |
| `HISTORY_DAYS` | `7` | **Reserved — not yet applied.** Retention is fixed at 48 hours in the sampler. |
| `ENABLE_GPU` | `true` | NVML telemetry. Set `false` on a host with no NVIDIA GPU. |
| `ENABLE_GPU_RENDER` | `false` | Offscreen EGL render, written to the fixed path `/opt/dashboard/static/gpu_scene.png`. Needs `moderngl`, `numpy`, `Pillow` (commented out in `requirements.txt` — uncomment and reinstall) and a GPU visible to the process. Also note `/api/gpu` returns HTTP 500 while this is off; the bundled front end tolerates that. |

Booleans accept `1`, `true`, `yes`, `on` (case-insensitive); anything else is false.

## Tuning the guest categories

Planet colour comes from substring-matching a guest's name against the `CATS`
table in `app.py`. If your naming convention differs, edit that table — it is
plain data:

```python
CATS = [
    ("media", ["jellyfin", "plex", "sonarr", ...]),
    ...
]
```

Unmatched guests fall back to `infra`, so a guest is never dropped from the
scene just because it is unrecognised.

## Security

- Nothing here is logged. Pollers print the *name* of a failing backend and the
  exception, never the credential.
- Keep `.env` at mode `0600` and owned by the service account. The installer in
  `deploy/` does this for you.
- Prefer a dedicated read-only account per backend over reusing an admin login.
- The dashboard itself has **no authentication**. Front it with your reverse
  proxy or SSO; do not expose it to the internet.
