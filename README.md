# Homelab Galaxy Dashboard

A cinematic 3D monitoring console for a Proxmox homelab.

Each Proxmox node becomes a spiral galaxy. Every VM and container is a lit planet
in its node's galaxy — coloured by what it does, sized by its RAM, dimmed when
stopped, haloed when Zabbix has an active problem against it. Storage pools are
ringed worlds. NVR cameras orbit as live video satellites. Network flows arc
between planets as travelling packets.

It is a real monitoring tool, not a toy: the scene is driven entirely by live
data polled in the background from Proxmox, Zabbix, UniFi, Frigate, Prometheus,
ntopng and LibreNMS. Nothing in the view is decorative-only — if a planet is
red, something is actually wrong.

Built to run on a wall-mounted display in kiosk mode.

---

## Why this exists

Grafana is excellent at "here is a time series". It is much weaker at the
question a homelab operator actually asks first: **what is my estate, and what
in it is unhappy right now?**

Answering that normally means five tabs — Proxmox for guests, Zabbix for
problems, UniFi for clients, the NVR for cameras, `nvidia-smi` for the GPUs.
This puts all of it in one spatial view you can read from across the room, and
degrades gracefully to a plain HUD when WebGL is unavailable.

---

## Features

| | |
|---|---|
| **Proxmox-native** | Guests, per-node CPU/memory/load/uptime, storage, and ZFS pool health *including* `DEGRADED` state and fragmentation — not just percent-used. |
| **Zabbix integration** | Host and problem counts, per-host worst severity mapped onto the matching planet, top active alerts panel. Bearer-token auth for Zabbix ≥ 7.0. |
| **Live cameras** | Frigate JPEGs proxied server-side and mapped onto orbiting satellite screens, so the browser never talks to the NVR directly. |
| **GPU telemetry** | NVML utilisation / memory / temperature / power per card, plus remote GPUs via `nvidia_gpu_exporter`. |
| **Network topology** | UniFi clients and WAN throughput, optional LibreNMS device constellation, optional ntopng host-to-host flow arcs. |
| **History** | Background sampler writes GPU, guest and network scalars to SQLite; `/api/history` serves them back for the in-scene sparklines. |
| **Degrades gracefully** | No WebGL, no GPU, or a dead backend each disable only their own layer. A HUD fallback renders the same data as plain panels. |
| **Kiosk-ready** | A second `/desk` view tuned for a fixed wall display, and a systemd unit for a loop-guarded kiosk browser. |

## Screenshots

*Not yet included.* Any screenshot of a running instance necessarily shows real
infrastructure — and, if `FRIGATE_URL` is configured, live frames from your
cameras. Capture yours with the NVR layer disabled:

```bash
FRIGATE_URL= ENABLE_GPU_RENDER=false python3 app.py
```

---

## Requirements

- Python 3.10+
- A Proxmox VE cluster or standalone node (8.x / 9.x), with a **read-only** API token
- A browser with WebGL2 for the 3D view (anything else falls back to the HUD)
- *Optional:* an NVIDIA GPU on the host for the telemetry panels

Everything else — Zabbix, UniFi, Frigate, Grafana, Prometheus, ntopng, LibreNMS
— is optional. Leave its URL blank and that layer is skipped. See
[What is optional](#what-is-optional) for exactly what each one adds.

## Getting started

The whole path, in order. Only step 3 requires touching another system; every
other step happens on the machine that will run the dashboard.

### 1. Clone and install dependencies

```bash
git clone https://github.com/NetworkBound/homelab-galaxy-dashboard.git
cd homelab-galaxy-dashboard

python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` installs Flask, requests and `nvidia-ml-py`. The NVML import
is tolerated failing at runtime, so installing it on a machine with no NVIDIA
driver is harmless — the GPU panels are skipped with a log line.

### 2. Create a read-only Proxmox API token

On any Proxmox node, as root:

```bash
pveum user add dashboard@pve
pveum aclmod / --users dashboard@pve --roles PVEAuditor
pveum user token add dashboard@pve readonly --privsep 0
```

The last command prints a UUID secret **once**. Combine it with the user and
token id into the single string the dashboard expects:

```
dashboard@pve!readonly=<the-uuid-it-printed>
```

`PVEAuditor` is a read-only role and the dashboard issues no write calls, so
this token cannot alter your cluster. Never use a root password or a
root-privileged token here.

### 3. Gather optional credentials

Each of these unlocks one layer. Skip any you do not run.

- **Zabbix** — create a dedicated user with a read-only role. You need the URL
  of `api_jsonrpc.php`, the username and the password. Works with Zabbix ≥ 7.0
  (bearer-token auth is handled automatically).
- **UniFi** — create a local read-only account on the controller (not your
  Ubiquiti SSO login). You need the controller base URL, username and password.
  Note that only the `default` site is queried; see
  [`docs/configuration.md`](docs/configuration.md).
- **Frigate** — just the base URL of the NVR, e.g. `http://10.0.0.30:5000`.
- **Grafana** — a viewer-scoped service-account token, used only for an
  up/down pip and a dashboard count.
- **Prometheus, ntopng, LibreNMS, Ollama** — see
  [`docs/data-sources.md`](docs/data-sources.md) for what each contributes and
  which credentials, if any, it needs.

### 4. Configure

```bash
cp .env.example .env
$EDITOR .env
```

At minimum, fill in the `PVE_0_*` block with your node's name, URL and the
token from step 2:

```ini
PVE_0_NAME=pve1
PVE_0_URL=https://10.0.0.10:8006
PVE_0_TOKEN=dashboard@pve!readonly=00000000-0000-0000-0000-000000000000
```

`PVE_0_NAME` must be the node name exactly as Proxmox knows it (the name shown
in the Proxmox UI's tree), because it is interpolated into API paths like
`/nodes/<name>/status`. A mismatch is the classic half-working state: planets
appear but node vitals, storage and ZFS pools stay empty.

More nodes are added as `PVE_1_*`, `PVE_2_*` and so on — numbering must be
contiguous from 0. Every other block in `.env.example` is optional and
commented out; uncomment and fill only what you use.

### 5. Run it

```bash
set -a; . ./.env; set +a
python3 app.py
```

If configuration is incomplete the app prints exactly what is missing —
"Configuration incomplete — the dashboard cannot start", one line per problem —
and exits non-zero rather than starting into a broken scene.

### 6. Open it and confirm data is arriving

Open <http://localhost:8080> (or whatever `LISTEN_HOST`/`LISTEN_PORT` you set).

Within a few seconds of the first poll cycle you should see:

- one spiral galaxy per configured Proxmox node, with a planet per guest;
- guest and node counts in the HUD panels;
- coloured pips for each optional backend you configured.

To verify from the command line instead, ask the API directly:

```bash
curl -s http://localhost:8080/api/all | python3 -m json.tool | head -40
```

A healthy install shows a non-empty `guests` list and a recent `ts` timestamp.
Layers you did not configure are present but empty — that is normal. If
something is wrong, the process log names the failing poller and backend, e.g.
`[pve] pve1 ...` or `[zbx] ...`; see [Troubleshooting](#troubleshooting).

## What is optional

Only Proxmox is required. Each row below is one independent layer; leaving its
configuration blank skips it and costs you only what is listed.

| Backend | Config | What you lose without it |
|---|---|---|
| Zabbix | `ZBX_*` | Problem halos on planets, alert panel, host/problem counts |
| UniFi | `UNIFI_*` | Client count, WAN throughput, the physical network tree in the topology view |
| Frigate | `FRIGATE_URL` | Camera satellites, per-camera FPS/detector stats, recording storage estimate |
| Prometheus | `PROM_URL` | Hypervisor temperatures (via node_exporter hwmon) |
| Grafana | `GRAFANA_URL`, `GRAFANA_TOKEN` | An up/down pip and dashboard count in the sources panel |
| ntopng | `NTOPNG_*` | Host-to-host flow arcs between planets |
| LibreNMS / any SNMP source | `NETMAP_URL` | The device constellation from an external topology JSON |
| Ollama | `OLLAMA_URL` | The in-scene chat box (`/api/chat` reports chat as disabled) |
| Local NVIDIA GPU | `ENABLE_GPU` | Local GPU telemetry panels |
| Remote GPUs | `GPUX_*` | Telemetry for GPUs on other machines |
| Service probes | `SVC_*` | Coloured health pips for arbitrary HTTP endpoints |
| Fleet checks | `FLEET_*` | Up/down pips for arbitrary `host:port` targets |

## Deploying

See [`deploy/`](deploy/) for a systemd unit and an installer that sets up a
service account, a virtualenv, and a root-owned environment file readable only
by the service:

```bash
sudo ./deploy/install.sh
```

The installer copies the application to `/opt/homelab-galaxy-dashboard`, seeds
`/etc/homelab-galaxy-dashboard/env` from `.env.example` (never overwriting an
existing one), and installs `deploy/homelab-dashboard.service`. On a first
install it stops there and tells you to edit the environment file before
enabling the service.

For the wall display, [`deploy/kiosk.service`](deploy/kiosk.service) starts a
loop-guarded Chromium in kiosk mode pointed at `/desk`. It is not installed by
`install.sh` — copy it to `/etc/systemd/system/` yourself. It expects a local
user named `kiosk`, a running X session on `:0`, Chromium at
`/usr/bin/chromium`, and the dashboard on port 8080; edit the unit if any of
those differ on your box.

---

## Configuration

All configuration is environment-driven and documented inline in
[`.env.example`](.env.example); the resolution logic lives in
[`config.py`](config.py).

Lists are declared with contiguous indexed variables, so you can add as many
nodes, probes, or GPUs as you like without touching Python:

```ini
PVE_0_NAME=pve1
PVE_0_URL=https://10.0.0.10:8006
PVE_0_TOKEN=dashboard@pve!readonly=...

PVE_1_NAME=pve2
PVE_1_URL=https://10.0.0.11:8006
PVE_1_TOKEN=dashboard@pve!readonly=...
```

Deeper notes:

- [`docs/architecture.md`](docs/architecture.md) — how the pollers, cache and scene fit together
- [`docs/data-sources.md`](docs/data-sources.md) — what each backend contributes and the exact API calls used
- [`docs/configuration.md`](docs/configuration.md) — every environment variable, with defaults

## HTTP API

The front end is a client of a small JSON API, so you can drive your own view
from the same data.

| Endpoint | Returns |
|---|---|
| `GET /api/all` | Everything: guests, nodes, storage, pools, UniFi, Zabbix, cameras, health, topology, fleet |
| `GET /api/gpu` | Per-GPU utilisation, memory, temperature, power. Errors (HTTP 500) unless `ENABLE_GPU_RENDER=true`; the bundled front end tolerates that and drops the GPU panels. |
| `GET /api/topology` | The network topology tree with measured per-link rates |
| `GET /api/history?mins=<n>&guest=<vmid>` | CPU/memory series for one guest |
| `GET /api/history?mins=<n>&metric=gpu&idx=<i>` | Utilisation/memory/temperature/power series for one GPU |
| `GET /api/history?mins=<n>&metric=net` | Clients, WAN rx/tx and problem-count series |
| `GET /cam/<name>.jpg` | Server-proxied still from the NVR |
| `POST /api/chat` | Prompt relay to Ollama (only if `OLLAMA_URL` is set; the model name is fixed to `qwen2.5:7b` in `app.py`) |

`mins` defaults to 120.

## Troubleshooting

Every poller logs a bracketed tag (`[pve]`, `[zbx]`, `[netmap]`, `[sampler]`,
`[gpu]`, ...) plus the exception to stdout — under systemd that is
`journalctl -u homelab-dashboard`. Credentials are never logged. That log is
the first place to look; the entries below cover the failure modes with
non-obvious symptoms.

**The app exits immediately with "Configuration incomplete".**
This is the startup validator in `config.py` doing its job. It lists each
problem on its own line — usually a missing `PVE_0_*` value, or a backend URL
set without its credentials. Fix the named variables and re-run. Remember the
`.env` file is only read if you source it (`set -a; . ./.env; set +a`) or load
it via systemd's `EnvironmentFile=`.

**The scene is black, then plain panels appear after a few seconds.**
That is the HUD fallback working as designed. The page gives the 3D scene 4.5
seconds to report ready; if WebGL2 is unavailable, a vendored script failed to
load, or a script error occurred, it switches to rendering the same `/api/all`
data as flat panels. Check the browser console for the underlying error. On
kiosk hardware without GPU acceleration the HUD is the expected steady state.

**The scene renders but is empty — no galaxies.**
The browser is fine; no guest data has arrived. Hit `/api/all` and look at
`guests`. If it is empty, check the process log for `[pve]` lines: wrong URL,
unreachable node, or a rejected token (Proxmox answers 401 with an invalid
token string — the format is `user@realm!tokenid=secret`, all one string).

**Planets appear, but node vitals, storage and pools are empty.**
`PVE_<n>_NAME` does not match the node's actual name. The guest list comes from
`/cluster/resources`, which works cluster-wide, but per-node calls interpolate
the configured name into the URL and fail with it wrong. Look for `[pve-node]`
and `[pve-stor]` errors in the log.

**Proxmox uses a self-signed certificate. Do I need to do anything?**
No. All backend requests are currently made with TLS verification disabled, so
self-signed certificates are accepted. Be aware of what that means: the
dashboard does not authenticate the backends it polls, so run it on a network
segment you trust. `PVE_VERIFY_TLS` exists in the configuration but is reserved
— it is not applied to requests yet.

**One panel is stale or missing but everything else works.**
Pollers are isolated: a dead backend removes only its own layer, and a poller
only overwrites its data on a successful fetch, so the last good reading stays
on screen. Find the matching bracketed tag in the log to see the actual error.
The panel recovers on its own once the backend is reachable again.

**The UniFi client count froze, or briefly showed nothing.**
A UniFi OS gateway returns an empty client list rather than an error once its
session cookie expires. The poller treats an empty list as "session expired":
it keeps the last-good reading on screen and logs in again on the next cycle
instead of flashing the count to zero. A count frozen for more than a minute
means logins themselves are failing — check the credentials and use a local
account, not Ubiquiti SSO.

**"[gpu] NVML unavailable, GPU panels disabled" at startup.**
Expected on any host without an NVIDIA GPU or driver, including containers
without GPU passthrough. The app continues; only the local GPU panels are
absent. Set `ENABLE_GPU=false` to skip the probe and silence the line. Remote
GPUs via `GPUX_*` do not need NVML.

**The browser console shows `/api/gpu` failing with a 500.**
Known behaviour when `ENABLE_GPU_RENDER` is false (the default): the endpoint
references the render backend unconditionally. The front end catches the
failure, so the only effect is missing GPU panels in the UI.

**Sparklines are empty and the log repeats `[sampler]` errors.**
The history sampler currently writes to a fixed path, `/opt/dashboard/metrics.db`
— the `METRICS_DB` variable is not applied yet. If that directory does not
exist, or is not writable by the service (the hardened systemd unit only
permits writes under `/var/lib/homelab-galaxy-dashboard`), every sample fails
and `/api/history` stays empty. Everything else keeps working. To get history,
create `/opt/dashboard/` writable by the service user, or adjust `DBPATH` in
`app.py`.

**Camera tiles are black or broken.**
With `FRIGATE_URL` unset, `/cam/<name>.jpg` returns 404 — the layer is off.
With it set but the NVR unreachable, the proxy returns an empty image rather
than an error, which renders as a black tile. Check that the dashboard host
(not the browser — frames are proxied server-side) can reach the Frigate URL.

**The chat box answers "(chat disabled: OLLAMA_URL is not configured)" or "(ollama unavailable: ...)".**
The first means exactly what it says. The second means `OLLAMA_URL` is set but
the request failed — the server may be down, or the model missing: the relay
requests `qwen2.5:7b` by name, so `ollama pull qwen2.5:7b` on the Ollama host,
or change the model string in `app.py`.

**The kiosk display never paints.**
`deploy/kiosk.service` deliberately waits, polling `http://localhost:8080/`
until the dashboard answers, so a wall display never shows a connection error
on boot. If it waits forever, the dashboard service is not up — fix that first.
Also confirm the `kiosk` user exists, X is on display `:0`, and Chromium is at
`/usr/bin/chromium`.

---

## Security notes

- Credentials are read from the environment. Pollers log the name of a failing
  backend and the exception, never the credential, and credentials are never
  sent to the browser.
- The Proxmox token should be `PVEAuditor` (read-only). The app issues no writes.
- Camera frames are proxied server-side, so browsers never need a route to the NVR.
- Outbound TLS verification is currently disabled for all backend requests, as
  is normal for Proxmox's self-signed default certificate — but it applies to
  every backend. Treat the network path between the dashboard and its backends
  as trusted, or terminate TLS somewhere you control. `PVE_VERIFY_TLS` is
  reserved for future use and not yet enforced.
- **There is no authentication in front of this dashboard.** It exposes a
  read-only picture of your infrastructure. Put it behind your reverse proxy,
  SSO, or a trusted VLAN — do not expose it to the internet.

## Contributing

Issues and pull requests are welcome. The one hard rule: **never commit a
credential, a private IP, or a hostname from your own network.** `.env` is
gitignored; keep it that way.

## License

MIT — see [LICENSE](LICENSE).
