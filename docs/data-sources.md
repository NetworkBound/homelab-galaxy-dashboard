# Data sources

Every backend below is optional except Proxmox. Leave a URL unset and the
matching poller returns immediately; the dashboard renders without that layer.
Each block lands in `/api/all` (and, for the edge blocks, `/api/topology`) with
an `up` flag; the screens degrade per block.

---

## Proxmox VE — required

**Config:** `PVE_<n>_NAME`, `PVE_<n>_URL`, `PVE_<n>_TOKEN`, `PVE_VERIFY_TLS`

Authenticates with an API token header, never a ticket:

```
Authorization: PVEAPIToken=<user>@<realm>!<tokenid>=<secret>
```

| Endpoint | Used for |
|---|---|
| `/api2/json/nodes` | Which node names the endpoint runs (inventory; cached in `DATA_DIR/.inventory.json`) |
| `/api2/json/cluster/resources?type=vm` | Every VM and container — the planets; cumulative `netin/netout` for the topology rates |
| `/api2/json/nodes/<node>/status` | Hypervisor CPU, cores, memory, load average, uptime, kernel |
| `/api2/json/nodes/<node>/storage` (+ `/content?content=backup`) | Datastores and their used/total; newest backup per guest |
| `/api2/json/nodes/<node>/disks/zfs` (+ `/<pool>`) | ZFS pool health, fragmentation, read/write/checksum errors, scrub age |
| `/api2/json/nodes/<node>/{lxc,qemu}/<vmid>/config` | Each guest's static IP and MAC, so flows can be mapped onto planets |

The ZFS call is the one worth calling out: it surfaces pool `health`, so a
`DEGRADED` array shows up as a state change and not merely as a percentage that
happens to look normal.

**Token creation:**

```bash
pveum user add dashboard@pve
pveum aclmod / --users dashboard@pve --roles PVEAuditor
pveum user token add dashboard@pve readonly --privsep 0
```

`PVEAuditor` is read-only; the dashboard issues no writes.

Nodes do not need to be clustered. Two standalone nodes work fine — declare each
as its own `PVE_<n>_*` block and each gets its own galaxy. A clustered endpoint
declared once contributes every node it reports.

---

## Zabbix

**Config:** `ZBX_URL`, `ZBX_USER`, `ZBX_PASS`

> **Zabbix ≥ 7.0 changed authentication.** `user.login` still returns a token,
> but it must be sent as an `Authorization: Bearer <token>` header. This client
> uses the header form. `apiinfo.version` must be called *without* it.

| Method | Used for |
|---|---|
| `user.login` | Obtain the bearer token (re-obtained on expiry) |
| `host.get` | Monitored host count |
| `problem.get` | Active problems, with severity; the newest eight with host + age |
| `trigger.get` | Mapping a problem back to the host that owns it (`monitored: true` mirrors the UI) |
| `item.get` / `trigger.get` (counts) | Item and trigger totals for the sources panel |

The worst active severity per host is mapped onto the matching planet by name,
so a Zabbix problem shows up as a red flare on the guest it belongs to. A *new*
problem at or above `ALERT_SEV` also flips the display mode to `alert`
(rising-edge against a baseline, so standing problems never park the wall in red).

---

## UniFi

**Config:** `UNIFI_URL`, `UNIFI_USER`, `UNIFI_PASS`, `UNIFI_SITE`

Logs in to `/api/auth/login` and holds the session, then reads
`/proxy/network/api/s/<site>/stat/sta` for clients, `/stat/device` for
infrastructure (and the physical uplink tree), `/stat/health` for WAN status,
throughput, the ISP name and the real upstream next hop, `/rest/networkconf`
for the gateway's LAN addresses, and `/rest/user` for every client the
controller has ever seen — a named host that is asleep is drawn as *down*, not
silently gone.

> A UDM returns an **empty list rather than an error** when its session has
> expired. The poller treats an empty client list as "session expired": it keeps
> the last-good reading on screen and re-logs-in on the next cycle.

Use a local read-only UniFi account, not your Ubiquiti SSO login.

---

## Frigate NVR

**Config:** `FRIGATE_URL`, `NP_NVR_IP`

Camera names come from `/api/config`; stills are fetched server-side and served
to the browser at `/cam/<name>.jpg`, event thumbnails at
`/frigate/thumb/<id>.jpg`. Proxying rather than embedding the NVR URL directly
means **browsers never need a network route to the NVR**. `/api/stats` feeds
per-camera fps, detector inference time, recording storage and an estimated
retention; `/api/events` the recent detections on the showtime panel. A Coral
USB accelerator is detected via sysfs.

---

## Ollama

**Config:** `OLLAMA_<n>_NAME/URL/GPUS/LABEL`, `OLLAMA_URL`, `OLLAMA_MODEL`

Each instance is polled at `/api/ps` (loaded models, VRAM, and — by watching
`expires_at` refresh — whether a request just ran) and `/api/tags`. The chat
box relays to `<OLLAMA_URL>/api/generate` with `OLLAMA_MODEL`.

Hosts declared with `AISRV_<n>_*`, and any guest whose name matches
`AI_MARKERS`, are probed at `:11434/api/tags` and `:9100/metrics` for the
AI-server readout panel.

---

## Prometheus

**Config:** `PROM_URL`

Three uses:

- node-exporter hwmon temperatures per Proxmox host (matched by the address in
  `PVE_<n>_URL`);
- the **telemetry** panel (`/api/telemetry`): a fixed set of PromQL queries
  folded into one dict — IPMI watts/fans/temps, SMART health, ZFS ARC, Proxmox
  Backup Server freshness, unpoller AP clients and WAN rates, Gatus SLO,
  LiteLLM traffic, CrowdSec alerts/bans, Akvorado flow rates. Every metric is
  optional: what your Prometheus does not scrape is simply `null`;
- `/api/prom?query=` — a read-only PromQL passthrough for the pages.

## Remote GPU exporters

**Config:** `GPUX_<n>_NAME`, `GPUX_<n>_URL`

For GPUs in machines *other* than the one running the dashboard. Expects
[`nvidia_gpu_exporter`](https://github.com/utkuozdemir/nvidia_gpu_exporter)
Prometheus text output; metrics are grouped by GPU UUID. Local GPUs are read
directly through NVML, which needs no exporter.

---

## LibreNMS topology

**Config:** `NETMAP_URL`

Points at a JSON document describing your SNMP estate:

```json
{
  "total": 2,
  "up": 1,
  "devices": [
    { "name": "core-sw", "ip": "10.0.0.2", "up": true,  "tier": "network" },
    { "name": "ap-1",    "ip": "10.0.0.9", "up": false, "tier": "edge" }
  ]
}
```

Devices nothing else lists (including every *down* device) become topology
nodes under the gateway; devices the prober found get their SNMP name. `down`
devices also raise the pulse severity on both screens.

---

## ntopng

**Config:** `NTOPNG_URL`, `NTOPNG_USER`, `NTOPNG_PASS`, `NTOPNG_IFNAME`, `NTOPNG_IFID`

Provides host-to-host flows, rendered as travelling packet arcs between planets.
`NTOPNG_IFNAME` is the capture interface resolved to an ntopng interface id via
`/lua/rest/v2/get/ntopng/interfaces.lua` — on a Proxmox host usually the bridge,
`vmbr0`, which sees guest-to-guest traffic that never touches the physical switch.

Flow sampling is rate-based: byte counters are differenced between samples and
smoothed with a light EMA over roughly three samples. The busiest N flows are
always kept, plus any LAN-to-LAN flow above a floor. External endpoints are
stamped with country/ASN when Akvorado has seen them.

## Active probing (fping)

**Config:** `ENABLE_PROBE`

Everything else is passive. With `fping` installed the prober measures real
RTT / jitter / loss for every address the topology knows (one process, all
targets in parallel) and sweeps the /24s those addresses live in — never a
subnet the dashboard has no business touching — to find hosts no controller
lists. A host that answers ARP but not ICMP is reported `icmp_silent`, not
down. RTT history is sampled into SQLite and `/api/rtt/baseline` gives each
host its own median, so "slow" is relative to that host's normal.

## TLS certificate expiry

**Config:** `NP_CERT_HOSTS` — comma-separated `host` or `host:port`, port
defaults to 443. Opens a TLS connection and reads `notAfter`.

## Grafana

**Config:** `GRAFANA_URL`, `GRAFANA_TOKEN`

Up/down and a dashboard count in the sources panel. A viewer-scoped
service-account token is sufficient.

---

## The internet edge (`edge.py`)

### cloudflared metrics

**Config:** `CLOUDFLARED_METRICS_URL`

Run the tunnel with `--metrics 0.0.0.0:20241` (or `metrics:` in its config)
and point this at `/metrics`. Cumulative counters are differenced here into
requests/min and errors/min; HA connections, edge locations, responses by
status code, active streams and a p50 connect latency (from the histogram)
appear on the WAN node and in `edge.cloudflare`. These are tunnel *requests*,
not viewers — only `edge.audience` carries real unique visitors.

### CrowdSec export

**Config:** `CROWDSEC_EXPORT_URL`

The country and AS of an attacker only exist in `cscli` output, so a 1-minute
cron on the CrowdSec host writes `cscli alerts list -o json` and
`cscli decisions list -o json` into a directory nginx serves read-only to the
dashboard: `deploy/edge/galaxy-cs-export.sh`, `galaxy-export.cron`,
`galaxy-export-site.conf.example`. Alerts in the last hour / 24 h, active bans,
top attackers with country and AS feed `edge.crowdsec` and the threat timeline.

### Akvorado

**Config:** `AKVORADO_URL`

The console API (`POST /api/v0/console/graph/line`) over the last hour: top
external destinations and sources with country + ASN, per-country in/out,
internal talkers, totals → `external`. The ip → geo map it learns also
enriches ntopng flows.

---

## Security and audience (`threats.py`)

### Security Monitor

**Config:** `SECMON_URL`, `SECMON_TZ`

Any service exposing `/api/stats/summary` (`threat_level` 0–3, `threat_name`,
`findings.active` by severity) and `/api/findings` (`id`, `title`, `severity`,
`category`, `found_at`, `affected_hosts`, `acknowledged`) sets the threat
level and contributes findings to the timeline. Naive `found_at` timestamps
are interpreted in `SECMON_TZ`.

### Cloudflare analytics

**Config:** `CF_API_TOKEN` (Analytics:Read), `CF_ZONE_ID`

One GraphQL query against `httpRequestsAdaptiveGroups` for the last 5 min and
60 min: requests and *unique* visitors, top countries, top hostnames →
`edge.audience` with `source: cloudflare-graphql`.

### Origin-log audience exporter

**Config:** `AUDIENCE_URL`

Without an analytics token, real viewers come from the origin instead: nginx
logs `CF-Connecting-IP`, `CF-IPCountry` and `host` for every proxied request
(`deploy/edge/galaxy-audience-log.conf`) and a 1-minute cron
(`galaxy-audience-export.py`) writes `audience.json` next to the CrowdSec
export. Same shape as the GraphQL path with `source: origin-log`; monitors and
bots are counted separately and never mixed into viewers. When both are
configured the GraphQL path is preferred and the export is the fallback.

### The unified timeline — `/api/threats` (+ `/stream`)

CrowdSec alerts and Security Monitor findings, de-duplicated, newest first,
with a monotonic `seq` that only advances on an event that is both unseen *and*
recent — so the backlog that loads in the first seconds after boot never fires
the stream or the room lights. Both screens subscribe; the wall flips the
lights to mode `threat` for a couple of seconds on a new event.

---

## Emby / Jellyfin

**Config:** `EMBY_URL`, `EMBY_API_KEY`

`/emby/Sessions` (Jellyfin: `/Sessions`, tried automatically) with the
`X-Emby-Token` header: sessions, what is playing (title, transcode vs direct,
hardware decode, bitrate, progress, live TV), remote vs LAN clients →
`showtime.emby`.

---

## Lights and presence

**Config:** `ENABLE_LIGHTS`, `LIGHTS_STALE_S`, `PRESENCE_*`

- `/api/lightstate` (GET/POST + SSE `/stream`) is the colour and tour-protocol
  slot the wall publishes and the room-lights driver (`deploy/lights/`) reads;
  `/api/lightcolor` carries per-screen colours; `/api/lightenable` is the
  automation's intent (off = the driver writes nothing).
- `/api/presence` (GET/POST + SSE) is fed by a motion-sensor automation
  (`deploy/homeassistant/presence.yaml.example`). Both screens pause rendering
  and the offscreen EGL render idles when the room is empty.
- `/api/mode` (GET/POST + SSE): `wall | showcase | ops | night | alert`,
  persisted in `DATA_DIR/.mode.json`.

## Add-ons

Anything else: drop a `poll(config)` in `addons/<id>.py` and it becomes a row in
the ADD-ONS panel. See `addons/README.md`.
