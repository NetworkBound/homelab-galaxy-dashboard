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
               "lights": false, "doom": false, "setup": true, "chat": false, "snmp": false,
               "cinematics": false, "universe": true, "tour": true},
  "cinematics": {"laps": 3, "moves": ["roll", "explode", "closeup", "arc"]},
  "addons": ["speedtest", "backup-check"],
  "featured_node": "pve2",
  "sites": [{"id": "sys:branch", "label": "Branch office", "accent": "#fc8181"}]
}
```

- `nodes` is the ordered list of Proxmox nodes: `id` is the node name as Proxmox
  knows it (it appears in guest `node` fields and in ids like `pve:<id>`,
  `host:pve:<id>`, `guest:<id>:<vmid>`), `label` is what the screens print,
  `accent` is the galaxy colour. Accents default to a palette by index
  (cyan, amber, violet, green, rose, gold) when not configured.
- `features.doom` is true only when `static/doom/js-dos.js` exists on disk.
- `features.cameras` is true only when an NVR URL is configured.
- `features.snmp` is true when at least one SNMP target is configured (or in demo mode).
- `features.cinematics` reflects the server default for scripted camera moves; a
  screen can still override it per-session with `?cinematics=on|off`. The
  `cinematics` block gives the default lap count between moves and the rotation
  of move names; the front end clamps `laps` to 1..50 and ignores unknown moves.
- `featured_node` is the node whose galaxy gets one tour stop per guest category
  (`UI_FEATURED_NODE`, else the node with the most guests). `sites` lists the
  remote sites from `UNIVERSE_SITES` with their universe system ids.
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

## Access control (`auth.py`)

Off unless `DASH_API_KEY` is set, and then it applies to **every** route
(`before_request`), including pages, streams and `/static` — so a route added
later is covered without being decorated. Exempt: `/login` itself, plus
`/setup` and `/api/setup/*`, which carry their own token gate (below).

- Credentials, in the order they are read: `X-API-Key: <key>`, `?key=<key>`,
  then the `galaxy_session` cookie. An empty or absent value never
  authenticates, whatever the configuration; comparison is `hmac.compare_digest`.
- Any successful key presentation sets `galaxy_session` (`HttpOnly`,
  `SameSite=Lax`, `Secure` over HTTPS, 30 days). Its value is
  `HMAC-SHA256(key, "galaxy-session-v1")`, so it proves the key without
  carrying it and survives a restart. The front end needs this: `fetch()` and
  `EventSource` send no headers.
- Refused requests answer `401`. A browser navigation (`Accept: text/html`)
  gets the `/login` form as the body; anything else gets
  `{"error": "unauthorized", "detail": "..."}`.
- `POST /login` takes `key` (form or JSON) plus an optional same-site `next`;
  it answers `303` to `next` for a form post, `{"ok": true}` for JSON, and
  `404` when no key is configured. `GET /login` is the form.

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

## `GET /api/universe` — every device, one stable layout

One deduplicated registry of every device the dashboard knows about, grouped into
systems (galaxies), with a layout that is append-only: a device keeps its slot
forever (30 days after it was last seen), so both screens place it in the same
spot and a new device never reshuffles the others.

```json
{"v": 1, "ts": 1791156000.1, "fresh": true,
 "counts": {"total": 147, "up": 132, "down": 14, "new": 0, "lab": 1,
            "down_by": {"offline": 10, "stopped": 4, "gone": 0}, "by_class": {"phone": 9}},
 "systems": [{"id": "sys:pve1", "label": "pve1", "short": "PVE1", "kind": "pvehost",
              "accent": "#5ad7ff", "seed": 2959989296, "slot": 1, "count": 9,
              "anchor": "pve:pve1", "shells": {"0": 1, "3": 8}}],
 "bodies": [{"id": "mac:02:00:5e:10:00:01", "label": "Living room TV", "short": "Living room TV",
             "class": "tv_av", "cat": "media", "system": "sys:home", "parent": "unifi:...",
             "shell": 7, "slot": 2, "seed": 918273645, "status": "up",
             "first_seen": 1790000000, "last_seen": 1791155990, "new": false,
             "m": {"rx_bps": 1200.0, "wired": true}, "src": ["unifi"]}],
 "links": [{"a": "<body id>", "b": "<body id>", "kind": "uplink", "bps": 1000.0}],
 "traffic": {"ts": 1791450000.0, "window_s": 30,
             "pairs": [{"a": "sys:core", "b": "sys:pve2", "bps": 4600000.0,
                        "a_to_b_bps": 1200000.0, "b_to_a_bps": 3400000.0, "kind": "lan",
                        "links": 1, "layer": "interface", "top": [], "src": ["unifi_port"]}],
             "wan": [{"system": "sys:core", "in_bps": 900000.0, "out_bps": 150000.0, "bps": 1050000.0,
                      "via": "ISP", "layer": "interface", "src": ["unifi_wan"]}]}}
```

- Systems: `sys:core` (kind `network`: gateway, switches, APs), `sys:<node>` (kind
  `pvehost`, one per Proxmox node), `sys:home` (kind `clients`), `sys:<site>` (kind
  `site`, from `UNIVERSE_SITES`). New systems are appended; the screens branch on
  `kind`, never on an id.
- Body ids are stable: `vm:<node>:<vmid>` for guests, then `mac:` > `snmp:` > `ip:` >
  `name:`. Classes: `pve_host guest_vm guest_lxc gateway switch ap server storage
  computer phone tablet tv_av iot appliance camera printer game_console
  network_device edge unknown`.
- Honesty: an unmeasured value is absent, never 0. `status` is `up | down | idle |
  unknown`; a down body carries `down_why`: `offline` (an outage), `stopped` (a
  powered-off guest) or `gone` (no longer reported, holding its slot). `lab: true`
  marks bench gear (badge only, never an outage).
- `short` is the on-screen name (≤ 14 characters, unique inside a system); `label`
  is the full name for the detail card. `new: true` for 10 minutes after a device
  first appears (birth animation, "new device" cutaway).
- `traffic` (optional): measured traffic between systems, EWMA-smoothed, one
  measurement layer per pair (`interface` counters, else `flow` conversations,
  then `partial: true` = a lower bound). A pair with nothing measured is absent.
  In demo mode the object is synthetic and carries `demo: true`.

## `GET /api/tour` — the aspect stops and one problem vocabulary

```json
{"v": 1, "ts": 1791600000,
 "aspects": [{"key": "asp:cameras", "name": "Cameras", "anchor": "vm:pve1:113",
              "after": "host:pve:pve1", "status": "ok",
              "facts": [{"k": "Recording", "v": "4 / 4", "s": "ok"},
                        {"k": "Detector", "v": "6.4", "u": "ms", "s": "ok"}],
              "line": "4 cameras recording"}],
 "problems": [{"host": "mini-pc", "text": "no ping response", "sev": 4, "lab": false, "n": 1}]}
```

- `key` is one of `asp:internet asp:security asp:web asp:wifi asp:storage asp:power
  asp:monitoring asp:ai asp:cameras asp:media` (filter/order with `TOUR_ASPECTS`).
  `anchor` is a `/api/universe` body or system id; `after` is the tour stop the
  aspect follows (`wan`, `fabric` or `host:pve:<node>`).
- At most four `facts`; `s` is `ok | warn | crit | ""` (colour only for status). An
  aspect whose feeds are all missing or stale is listed with `status: "unknown"`.
- `problems`: one row per host (its worst problem), short host name and plain text,
  no addresses. Lab hosts and stopped guests are never red (`sev` capped at 3).

## Data the screens read (unchanged shapes, listed for completeness)

`/api/all` (`guests, nodes, nodes2, storage, pools, zfs, backups, unifi, zabbix,
zbx2, cameras, frigate, sources, health, latency, netmap, top, certs, telemetry,
probe, snmp, topology, edge, external, addons, ts`), `/api/topology` (`nodes, links,
flows, totals, flow_meta, edge, external`), `/api/gpu`, `/api/showtime`,
`/api/threats` (+`/stream`), `/api/lightstate` (+`/stream`, `/api/lightcolor`,
`/api/lightenable`; a wall may also send an optional `move` token and `move_dir`
of ±1 so the TV flies the same cinematic leg), `/api/mode` (+`/stream`), `/api/presence` (+`/stream`),
`/api/pulse/stream`, `/api/takeover` (+`/stream`), `/api/history`,
`/api/inventory`, `/api/telemetry`, `/cam/<name>.jpg`, `/frigate/thumb/<id>.jpg`.
`edge` contains `cloudflare`, `crowdsec`, `secmon`, `audience`, `threats`; any of
them may be `{"up": false, ...}` and the screens must degrade per block.

Topology node kinds are `wan | gateway | switch | ap | pvehost | guest | client |
external`. SNMP-polled devices are `switch` / `ap` / `gateway` nodes with id
`snmp:<host>` and `meta.snmp: true`, carrying `meta.ports[]` (`index, name,
alias, speed_bps, admin, oper, rx_bps, tx_bps, measured, hc, rx_err, tx_err`)
and `meta.neighbors[]` (`proto, port, sys_name, chassis_id, port_id, mgmt_ip,
node`, where `node` is the id of the node that neighbour resolved to, or
`null`). A neighbour nothing else lists is a `client` node `lldp:<chassis-mac>`
with `meta.lldp: true`. A device the map already had keeps its existing id and
gains the same `meta` keys. Rates that could not be measured are `null` with
`measured: false`; the screens must not animate those.

Two things the screens must never do: open a 6th `EventSource` (Chrome allows
six connections per host and each stream holds one; the pages already use
five), or label tunnel request counters as "viewers" — only `edge.audience`
carries real unique visitors.
