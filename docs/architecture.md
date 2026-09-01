# Architecture

## Shape of the system

```
  Proxmox ─┐
  Zabbix  ─┤
  UniFi   ─┼─▶ background poller threads ─▶ in-memory DATA dict ─▶ /api/all ─▶ browser ─▶ Three.js scene
  Frigate ─┤          │                                                          │
  ntopng  ─┘          └──▶ sampler thread ─▶ SQLite ─▶ /api/history ─────────────┘
```

Three deliberate properties fall out of this shape:

1. **The HTTP layer never blocks on a backend.** Every request is served from a
   dict that is already in memory. A Zabbix server that has gone away makes its
   poller log and retry; it does not make the dashboard slow.
2. **Failures are isolated.** Each poller is a `while True` loop whose body is
   fully wrapped in `try/except`, and each writes only its own key of `DATA`.
   One dead backend removes one layer from the scene.
3. **Last-good data survives.** Pollers only overwrite their key on a successful
   fetch, so a transient failure leaves the previous reading on screen rather
   than blanking the panel.

## Modules

| File | Responsibility |
|---|---|
| `config.py` | Resolves all configuration from the environment. The only place that knows what is site-specific. |
| `app.py` | Flask app, the `DATA` cache, the core pollers (Proxmox, Zabbix, UniFi, cameras, service health, fleet), the JSON API, and the SQLite sampler. |
| `pollers.py` | Second-tier pollers: per-node detail, TLS certificate expiry, backup freshness, Prometheus scrapes. |
| `topology.py` | Network topology and flow analysis — UniFi client graph, ntopng host-to-host flows, rate smoothing. |
| `gpu_render.py` | Optional offscreen EGL render of the scene on the server's GPU, written to the fixed path `/opt/dashboard/static/gpu_scene.png`. |
| `templates/index.html` | The 3D console. Scene construction, data binding, and the no-WebGL HUD fallback. |
| `templates/desk.html` | A denser, non-3D view intended for a fixed wall display. |
| `static/netscene.js`, `static/netscene_flows.js` | Topology and flow rendering layers. |
| `static/galaxy.js` | Galaxy geometry — spiral arms, planets, rings, satellites. |
| `static/new_panels.js` | HUD renderers for the second-tier telemetry keys: node vitals, ZFS pools, backups, Frigate, top talkers, certificate expiry, recent Zabbix problems, probe latency. |

## The `DATA` cache

A single module-level dict in `app.py`. Keys are written by exactly one poller
each, which is what makes the lock-free design safe:

| Key | Written by | Contents |
|---|---|---|
| `guests` | `poll_pve` | Every VM and container: id, name, type, status, node, CPU %, memory, category |
| `nodes` | `poll_pve` | Per-hypervisor CPU, cores, memory, load average, uptime |
| `storage`, `pools` | `poll_pve` | Datastores and ZFS pools including health and fragmentation |
| `unifi` | `poll_unifi` | Client count, device list, WAN throughput |
| `zabbix` | `poll_zbx` | Host count, problems by severity, worst severity per host |
| `cameras` | `poll_cams` | Camera names discovered from the NVR |
| `sources` | `poll_sources` | Up/down and headline number for each backend |
| `health` | `poll_health` | Result of each configured service probe |
| `netmap` | `poll_netmap` | External SNMP topology document |
| `fleet` | `poll_fleet` | Reachability of arbitrary `host:port` targets |

The second-tier pollers in `pollers.py` add their own keys on the same
one-writer-per-key rule: `nodes2` (per-node vitals incl. temperature), `zfs`
(per-pool health detail), `backups` (newest backup per guest, stale counts),
`frigate` (per-camera FPS and recording storage), `top` (top guests by CPU and
RAM), `certs` (TLS expiry), `zbx2` (Zabbix version and recent problems) and
`latency` (response-time trend of the health probes). `topology.py` writes
`topology`. All of them ride along on `/api/all` when populated.

## Guest categorisation

Guests are bucketed into `ai`, `media`, `network`, `monitor`, `web`, or `infra`
by substring-matching their name against the keyword lists in `CATS` (`app.py`).
The category drives planet colour and which galaxy arm a guest lands in.

This is intentionally a heuristic on names rather than configuration: homelab
guests are almost always named after the thing they run, and an unmatched guest
falls back to `infra` rather than disappearing. Extend `CATS` to match your own
naming convention.

## Rendering

The scene is Three.js with `EffectComposer` and `UnrealBloomPass`. Vendored
copies of Three and the required passes live in `static/vendor/` so the
dashboard has **no runtime CDN dependency** — it works on an isolated
management VLAN with no internet route.

Three render paths exist, selected at load:

1. **WebGL scene** — the full galaxy, when `THREE`, `OrbitControls` and
   `EffectComposer` are all present.
2. **HUD fallback** — triggered by a script error, or automatically after 4.5s
   if the scene never reported ready. Renders the same `/api/all` payload as
   plain panels.
3. **Server-side EGL render** (optional, `ENABLE_GPU_RENDER=true`) — renders
   offscreen on the host GPU via moderngl to a PNG, for clients that cannot run
   WebGL at all.

## History sampling

A sampler thread writes selected scalars — per-GPU utilisation, per-guest
CPU/memory, and network counts — to SQLite every 30 seconds, pruning anything
older than 48 hours. `/api/history` reads them back for the in-scene
sparklines, filtered by `guest=<vmid>`, `metric=gpu&idx=<i>` or `metric=net`,
with a `mins` window defaulting to 120.

The database path is currently fixed at `/opt/dashboard/metrics.db` (`DBPATH`
in `app.py`); the `METRICS_DB` and `HISTORY_DAYS` variables exist in the
configuration but are not applied yet. If the path is not writable the sampler
logs and retries — history stays empty, nothing else is affected.

This is deliberately a *small* store for glanceable trends. It is not a
replacement for Zabbix or Prometheus, and it does not try to be — if you want
real long-term time series, point `PROM_URL` at Prometheus and use Grafana for
the deep dives.
