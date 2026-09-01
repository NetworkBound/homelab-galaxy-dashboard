# Data sources

Every backend below is optional except Proxmox. Leave a URL unset and the
matching poller returns immediately; the dashboard renders without that layer.

---

## Proxmox VE — required

**Config:** `PVE_<n>_NAME`, `PVE_<n>_URL`, `PVE_<n>_TOKEN`, `PVE_VERIFY_TLS`

Authenticates with an API token header, never a ticket:

```
Authorization: PVEAPIToken=<user>@<realm>!<tokenid>=<secret>
```

| Endpoint | Used for |
|---|---|
| `/api2/json/cluster/resources?type=vm` | Every VM and container — the planets |
| `/api2/json/nodes/<node>/status` | Hypervisor CPU, cores, memory, load average, uptime |
| `/api2/json/nodes/<node>/storage` | Datastores and their used/total |
| `/api2/json/nodes/<node>/disks/zfs` | ZFS pool health, fragmentation, alloc/free |

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

Two things worth knowing before the first run:

- `PVE_<n>_NAME` must be the node name exactly as Proxmox reports it, because
  it is interpolated into the three `/nodes/<node>/...` paths above. With a
  wrong name the guest list still populates (it comes from the cluster-wide
  resources call) but node vitals, storage and pools stay empty.
- Requests are made with TLS verification disabled, so the self-signed
  certificate Proxmox ships works out of the box. `PVE_VERIFY_TLS` is reserved
  and not yet applied — see `docs/configuration.md`.

Nodes do not need to be clustered. Two standalone nodes work fine — declare each
as its own `PVE_<n>_*` block and each gets its own galaxy.

---

## Zabbix

**Config:** `ZBX_URL`, `ZBX_USER`, `ZBX_PASS`

> **Zabbix ≥ 7.0 changed authentication.** `user.login` still returns a token,
> but it must be sent as an `Authorization: Bearer <token>` header. The old
> `auth` field inside the JSON-RPC body is ignored and every call fails with a
> permission error. This client uses the header form.

| Method | Used for |
|---|---|
| `user.login` | Obtain the bearer token (re-obtained on expiry) |
| `host.get` | Monitored host count |
| `problem.get` | Active problems, with severity |
| `trigger.get` | Mapping a problem back to the host that owns it |
| `item.get` / `trigger.get` (counts) | Item and trigger totals for the sources panel |

The worst active severity per host is mapped onto the matching planet by name,
so a Zabbix problem shows up as a red flare on the guest it belongs to.

Give the dashboard its own Zabbix user with a read-only role rather than
reusing `Admin`.

---

## UniFi

**Config:** `UNIFI_URL`, `UNIFI_USER`, `UNIFI_PASS`, `UNIFI_SITE`

Logs in to `/api/auth/login` and holds the session, then reads
`/proxy/network/api/s/default/stat/sta` for clients, `/stat/device` for
infrastructure, and `/stat/health` for WAN status and throughput. The site
segment is currently fixed to `default`; `UNIFI_SITE` exists in the
configuration but is not applied yet.

> A UDM returns an **empty list rather than an error** when its session has
> expired. The poller treats an empty client list as "session expired": it keeps
> the last-good reading on screen and re-logs-in on the next cycle, instead of
> flashing the client count to zero.

Use a local read-only UniFi account, not your Ubiquiti SSO login.

---

## Frigate NVR

**Config:** `FRIGATE_URL`

Camera names come from `/api/config`; stills are fetched server-side and served
to the browser at `/cam/<name>.jpg`. Proxying rather than embedding the NVR URL
directly means **browsers never need a network route to the NVR**, and no NVR
credential ever reaches the client.

Each camera becomes an orbiting satellite screen with a live still refreshed on
an interval.

---

## Ollama

**Config:** `OLLAMA_URL`

Backs the in-scene chat box. `/api/chat` relays the prompt to
`<OLLAMA_URL>/api/generate` with the model name fixed to `qwen2.5:7b` — pull
that model on the Ollama host (`ollama pull qwen2.5:7b`) or change the string
in `app.py`. With `OLLAMA_URL` unset the endpoint reports chat as disabled and
nothing else changes.

Hosts declared with `AISRV_<n>_*` are additionally probed at
`http://<ip>:11434/api/tags` (Ollama model count) and `http://<ip>:9100/metrics`
(node_exporter reachability) for the AI-server readout panel.

---

## Prometheus

**Config:** `PROM_URL`

Used for host metrics that Proxmox does not expose — notably hardware
temperatures via `node_exporter`'s hwmon collector, taken as a best-effort max
per host.

## Remote GPU exporters

**Config:** `GPUX_<n>_NAME`, `GPUX_<n>_URL`

For GPUs in machines *other* than the one running the dashboard. Expects
[`nvidia_gpu_exporter`](https://github.com/utkuozdemir/nvidia_gpu_exporter)
Prometheus text output; metrics are grouped by GPU UUID.

Local GPUs are read directly through NVML instead, which needs no exporter.

---

## LibreNMS topology

**Config:** `NETMAP_URL`

Points at a JSON document describing your SNMP estate. The shape is
deliberately minimal so you can generate it from anything:

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

`tier` is free-form and groups devices into orbital rings; `network`, `host`,
`gpu`, `edge` and `container` are the values the layout is tuned for.

The usual production pattern is a cron job on the LibreNMS host that queries its
API and writes this file to a static path every couple of minutes — that keeps
LibreNMS credentials out of the dashboard entirely.

---

## ntopng

**Config:** `NTOPNG_URL`, `NTOPNG_USER`, `NTOPNG_PASS`, `NTOPNG_IFNAME`

Provides host-to-host flows, rendered as travelling packet arcs between planets.
`NTOPNG_IFNAME` is the capture interface to resolve to an ntopng interface id —
on a Proxmox host this is usually the bridge, `vmbr0`.

Flow sampling is rate-based: byte counters are differenced between samples and
smoothed with a light EMA over roughly three samples. The busiest N flows are
always kept, plus any LAN-to-LAN flow above a floor, so a quiet-but-interesting
flow is not crowded out by bulk transfers. Per-flow counter state is bounded;
when the cap is hit the interval is skipped rather than growing memory.

## TLS certificate expiry

**Config:** `NP_CERT_HOSTS` — comma-separated `host` or `host:port`, port
defaults to 443.

Opens a TLS connection to each host and reads the certificate's `notAfter`.
Hostnames only; no credentials are involved.

## Grafana

**Config:** `GRAFANA_URL`, `GRAFANA_TOKEN`

Only used for an up/down indicator and a dashboard count in the sources panel.
A viewer-scoped service-account token is sufficient.
