# Contracts between the back end, the front end, the setup wizard and add-ons

This file is the single source of truth the two screens, `demo.py`, `setup.py`
and add-ons are written against. If you change a shape here, change it everywhere.

## `GET /api/config` — what the front end needs before it draws anything

Served in every mode (demo or real). Never contains a credential.

```json
{
  "version": "2.0.0",
  "demo": false,
  "brand": "GALAXY",                 "domain": "example.com",
  "tagline": "live topology · flows · telemetry",
  "nodes": [ {"id": "pve1", "label": "PVE1", "accent": "#5ad7ff"},
             {"id": "pve2", "label": "PVE2", "accent": "#ffb347"} ],
  "wan_label": "ISP",
  "categories": ["ai", "media", "network", "monitor", "web", "infra"],
  "palette": {"ai": "#ff4fa3", "media": "#38e1ff", "network": "#37f5a0",
              "monitor": "#ffb347", "web": "#9b8cff", "infra": "#8fb0d0", "stopped": "#ff5a6a"},
  "features": {"nexus": true, "cameras": false, "threats": true, "audience": true,
               "lights": false, "doom": false, "setup": true, "chat": false},
  "addons": ["speedtest", "backup-check"]
}
```

- `nodes` is the ordered list of Proxmox nodes: `id` is the node name as Proxmox
  knows it (it appears in guest `node` fields and in ids like `pve:<id>`,
  `host:pve:<id>`, `guest:<id>:<vmid>`), `label` is what the screens print,
  `accent` is the galaxy colour. Accents default to a palette by index
  (cyan, amber, violet, green, rose, gold) when not configured.
- `features.doom` is true only when `static/doom/js-dos.js` exists on disk.
- `features.cameras` is true only when an NVR URL is configured.
- Everything in `brand`, `domain`, `tagline`, `wan_label`, `nodes[].label/accent`,
  `palette` and `categories` is user-editable in the setup wizard.

## Configuration layering

`config.py` resolves, in order of precedence: **environment variables** >
**`config.json`** (written by the setup wizard, path `CONFIG_FILE`, default
`./config.json`, or `/etc/homelab-galaxy-dashboard/config.json` when installed) >
**defaults**. `.env.example` documents every variable; `config.json` uses the
same keys in lower case grouped by section, e.g.

```json
{"pve": [{"name": "pve1", "url": "https://10.0.0.10:8006", "token": "..."}],
 "zabbix": {"url": "", "user": "", "pass": ""},
 "ui": {"brand": "GALAXY", "domain": "", "wan_label": "ISP",
        "node_accents": {"pve1": "#5ad7ff"}, "palette": {}, "categories": {"ai": ["ollama", "immich"]}},
 "features": {"doom": true, "lights": false}}
```

`config.json` may hold credentials, so the wizard writes it mode `0600`.

## Setup wizard (`setup.py`)

- `GET /setup` — the page. Enabled unless `SETUP_UI=false`.
- Gate: every `/api/setup/*` request carries `X-Setup-Token`. The token comes
  from `SETUP_TOKEN` or, if unset, is generated at first start, printed on the
  console (`[setup] token: ...`) and stored next to `config.json` as
  `setup-token` (`0600`). The page asks for it once and keeps it in
  `localStorage`. With no configuration at all, `/` redirects to `/setup`.
- `GET /api/setup/schema` — the list of sections/fields (label, type, help,
  required, current value with secrets masked as `"••••"`), so the page never
  hardcodes the field list.
- `GET /api/setup/config` — current effective config, secrets masked.
- `POST /api/setup/test` `{"section": "zabbix", "values": {...}}` — the server
  tries the connection with the given values and answers
  `{"ok": true, "detail": "Zabbix 7.0.4 · 76 hosts"}` or `{"ok": false, "error": "..."}`.
  One probe per section; probes never log the credential.
- `POST /api/setup/config` `{...}` — validates, merges (a masked `"••••"` keeps
  the stored secret), writes `config.json`, answers `{"ok": true, "restart": true}`.
- `POST /api/setup/apply` — re-executes the process so the pollers start with
  the new configuration (`os.execv`); under systemd the unit restarts it.

## Add-ons (`addons/`)

Any file `addons/<id>.py` is loaded at start (skipped in demo mode unless
`DEMO_ADDONS=1`). It may define:

```python
TITLE = "Speedtest"          # panel title (default: the file name)
INTERVAL = 600               # seconds between poll() calls (default 60)

def poll(config):            # runs in its own thread; return a panel payload
    return {"status": "up", "rows": [{"k": "down", "v": "912 Mb/s", "cls": "ok"}]}

def install(app, data):      # optional: add your own Flask routes
    ...
```

The loader writes `DATA["addons"][id] = {"title", "status", "rows", "ts", "error"}`;
a raised exception becomes `status: "down"` + `error` and never affects the
other add-ons. `/api/all` carries `addons`. The wall renders one row per add-on
in the **ADD-ONS** panel (title · status pip · rows); `/api/config.addons` lists
the ids so the screens can hide the panel when there are none. Row `cls` is
one of `ok | warn | bad` (or absent).

## Data the screens read (unchanged shapes, listed for completeness)

`/api/all` (`guests, nodes, nodes2, storage, pools, zfs, backups, unifi, zabbix,
zbx2, cameras, frigate, sources, health, latency, netmap, top, certs, telemetry,
probe, topology, edge, external, addons, ts`), `/api/topology` (`nodes, links,
flows, totals, flow_meta, edge, external`), `/api/gpu`, `/api/showtime`,
`/api/threats` (+`/stream`), `/api/lightstate` (+`/stream`, `/api/lightcolor`,
`/api/lightenable`), `/api/mode` (+`/stream`), `/api/presence` (+`/stream`),
`/api/pulse/stream`, `/api/takeover` (+`/stream`), `/api/history`,
`/api/inventory`, `/api/telemetry`, `/cam/<name>.jpg`, `/frigate/thumb/<id>.jpg`.
`edge` contains `cloudflare`, `crowdsec`, `secmon`, `audience`, `threats`; any of
them may be `{"up": false, ...}` and the screens must degrade per block.

Two things the screens must never do: open a 6th `EventSource` (Chrome allows
six connections per host and each stream holds one; the pages already use
five), or label tunnel request counters as "viewers" — only `edge.audience`
carries real unique visitors.
