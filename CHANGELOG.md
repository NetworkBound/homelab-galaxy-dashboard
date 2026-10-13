# Changelog

## Unreleased — the universe

The scene is no longer drawn from a handful of hardcoded node lists. Both
screens now read one registry of every device and fly a complete tour of the
estate.

### Added

- **`/api/universe`** (`universe.py`): one deduplicated registry of every device
  any feed reports — Proxmox guests and hosts, UniFi devices and clients, SNMP
  switches and their LLDP neighbours, probe discoveries, NMS devices, cameras,
  the internet edge — grouped into systems: the network core, one galaxy per
  Proxmox node, home, and any remote sites you declare (`UNIVERSE_SITES`).
  Identity is stable (`vm:` > `mac:` > `snmp:` > `ip:` > `name:`) and the layout
  is append-only: a device keeps its slot for 30 days after it was last seen and
  a new one never reshuffles the others. Unmanaged switches are detected from
  vendor, LLDP and chassis evidence or inferred from several wired clients on one
  port; operator files can name, merge or declare devices. Short on-screen names,
  `down_why` (offline / stopped / gone), lab gear and a guard that never mints
  ghosts from a short station list after an outage.
- **Measured traffic between galaxies**: switch-port, client and WAN counters,
  ntopng flows and (optionally) site-to-site tunnel interfaces from Zabbix,
  smoothed and aggregated per system pair. Unmeasured is absent, never zero.
- **`/api/tour`** (`tour.py`): ten aspect stops — internet, security, websites,
  Wi-Fi, storage, power, monitoring, AI, cameras, media — with at most four facts
  each, and one plain problem vocabulary ("host · problem") both screens share.
  Anchors are found by class and application name; `TOUR_ANCHORS` / `TOUR_ASPECTS`
  override them.
- **The look**: photographic galaxy plates per node, devices drawn as lit planets,
  moons and stars (`static/assets/celestial`), deep-sky fillers so wide shots fill
  the frame, measured traffic streams between galaxies, cinematic legs the TV
  mirrors, event cutaways and a calm, product-style UI with details on click.
- **Backups** now come from a PBS exporter in Prometheus when there is one (the
  storage listing as a fallback), with the last vzdump run per node; an
  unreadable source is reported as unknown, never as "never backed up".
- **Lab gear**: `UNIVERSE_LAB_GROUPS` / `UNIVERSE_LAB_HOSTS` / `UNIVERSE_LAB_VMIDS`
  or a Proxmox `lab` tag — a LAB badge, never an outage, never a red alert.
- Demo mode shows all of it: a remote site, a lab switch, synthetic traffic and
  devices that join the network while you watch.

### Fixed

- A clustered Proxmox endpoint no longer doubles every guest.
- Light sync: the wall reads every keepalive reply, so posts no longer stall after
  a few dozen requests.

## Unreleased — the clean-room pass

Someone cloned this repo, followed the README literally and wrote down every
place reality disagreed with it, then attacked the key gate added in #3. What
came out of that:

### Added — any managed switch or router in the topology (#1)

- **A first-class SNMP source** (`snmp.py`, `SNMP_<n>_*`, wizard section "SNMP
  devices"), asked for in #1 by Noah-2012: the infrastructure layer was UniFi
  only, so a Cisco, MikroTik or TP-Link switch was at best a leaf the prober
  found. Each listed device is now polled directly — sysName/sysDescr/
  sysObjectID/sysUpTime, the interface table with admin/oper status, speed,
  octet and error counters — and drawn as a real node with per-port measured
  throughput. **LLDP (CDP as the fallback for Cisco gear without it) turns
  the device list into a graph**: uplinks, Proxmox hosts and probed hosts on
  their real switch ports, and neighbours nothing else lists. A device the
  map already has — same chassis MAC, port MAC or management address as a
  UniFi device or a Proxmox host — is merged, never drawn twice; a display
  name is never a merge key. v2c and v3 (auth + privacy); every credential is
  a masked secret and absent from `/api/config`. 64-bit counters are
  preferred, a counter wrap or reset is *no reading* for that interval rather
  than a fake gigabit, and a 32-bit-only port that could wrap twice in the
  interval reports nothing. Only the listed targets are ever contacted. The
  **Test** button runs one real poll and says *which* of timeout /
  authentication / no-such-object happened. Optional `pysnmp` (pure Python);
  the base install and every existing test are unchanged without it. Demo
  mode gains two SNMP switches with ports and LLDP links.

### Added — who is watching, and a camera that moves (#1)

- **Live audience on both screens.** The wall grows an `AUDIENCE` panel ("N
  people on site", unique people over five minutes, a sixty-minute sparkline,
  per-country and per-host chips, bots and monitors shown as excluded) and the
  nexus gains a gold viewer headline with each visitor's country drawn as a
  labelled body. When the audience source is request-only the panel says so
  rather than inventing a visitor count. Hidden entirely when
  `features.audience` is false. Host chips and the wordmark come from your own
  `brand`/`domain`, so nothing site-specific is baked in.
- **Opt-in cinematic camera moves** (`ENABLE_CINEMATICS`, off by default;
  `CINEMATICS_LAPS` sets the cadence; a screen can also be driven with
  `?cinematics=on`). Every few tour laps, only at the full-estate overview, the
  camera plays one scripted move in rotation — orbit through the topology,
  explode the node tiers apart, close up on the busiest node with its real
  stats, or fly a flow arc — then returns exactly to the tour pose. Mouse or a
  DOOM takeover aborts instantly. Asked for in #1 by Noah-2012.
- **One beat per stop.** The room lights and the TV are driven by the tour's
  "beat"; it used to fire twice per leg (the stop key hands over at the travel
  midpoint and again on arrival), which showed up as a brightness flutter.
  Beats now fire once, on the travel-to-hold arrival.

### Fixed — the documented deploy path did not work at all

- **`deploy/install.sh` never copied `auth.py`.** It selected files from a
  hand-written list that `auth.py` was never added to, so a fresh
  `sudo ./deploy/install.sh` produced an `/opt` tree whose `app.py` opens with
  `import auth` and nothing to import: `ModuleNotFoundError` on every start,
  and `Restart=always` turning that into a permanent crash loop. It now copies
  every top-level module by glob, and refuses to finish if `app.py` imports
  something that did not land. `tests/test_deploy_install.py` checks this from
  the script itself.

### Fixed — a key with an accent in it locked you out of your own dashboard

- **`hmac.compare_digest` raises on non-ASCII `str`.** Both gates compared
  text, so `X-API-Key: ü` — from anyone, no credential needed — became an
  unhandled exception and HTTP 500 rather than 401, through the header, `?key=`
  and the session cookie; and `X-Setup-Token` did the same. Worse, a
  `DASH_API_KEY` containing a non-ASCII character meant the *correct* key
  raised too: every route 500ed for everybody, permanently, `/login` included.
  Both gates now compare UTF-8 bytes, so every input is a yes or a no and never
  a crash. Not a bypass — it always failed closed — but a lockout and a
  one-request way to fill the journal with tracebacks.

### Fixed — the wizard

- **Apply killed the app.** `/api/setup/apply` re-executes in place, but
  Werkzeug marks its listening socket inheritable and `os.execv` keeps
  inheritable descriptors, so the new image met its own still-bound port and
  exited with "Address already in use". Under systemd `Restart=always` hid it;
  run the way the README says to (`python3 app.py`) the dashboard simply died
  when you pressed Apply. Descriptors are now closed at exec.
- **Save, reload, save again used to wipe every credential.** The wizard reads
  through the `config.json` snapshot `config.py` takes at import, so after a
  save it kept answering with blank fields — and a blank means "clear this" to
  the save path. Two clicks destroyed the Proxmox token and the dashboard key.
  `save()` now refreshes that layer, so what the wizard shows is what is
  stored, masked, and is safe to post straight back.

### Fixed — guardrails and the deploy kit

- **The private-IP guardrail could not see inside a minified file.** It matched
  per line with a keyword allowlist, and every demo fixture is one line —
  `all.json` is 124 KB of it — so one incidental "example" excused all 133
  addresses in the file that is most likely to carry a real one. Replaced by
  `.github/ipscan.py`, which judges each address against the placeholder range
  and nothing else. A home-router address planted in `all.json` now fails the
  check; before, the same file passed it.
- **The kiosk ran Chromium with `--remote-allow-origins=*` and DevTools always
  on.** That pair removes the only thing stopping a page the kiosk browser has
  open from driving the whole browser. Remote debugging is now opt-in via
  `KIOSK_DEBUG_PORT` and bound to loopback.
- **The kiosk readiness probe spun forever once `DASH_API_KEY` was set**, because
  `curl -f` reads the gate's 401 as "not up yet". Any HTTP answer now counts.
- **The audience exporter copied two client-controlled strings through to the
  wall** — the Host header and `CF-IPCountry`, which is just a header on an
  origin reachable without Cloudflare. The front end escapes them, so this was
  not an exploitable injection, but the exporter now validates them itself.
- **CI's "No credentials anywhere in history" job was permanently red.** A blob
  arrives on stdin with no path, so `--stdin` judged every historical version
  of a file by stricter rules than the current one, and a synthetic Proxmox
  token in an older `tests/test_setup_api.py` failed the job on every push. The
  sweep now receives the path the blob was committed at and applies the same
  `ALLOW_PATH` rule as the working-tree scan. A gate that is always red is a
  gate that gets switched off.
- `deploy/edge/galaxy-cs-export.sh` gained `set -euo pipefail` and an explicit
  directory mode; `install.sh` writes the env file with `install -m 0640`
  instead of `cp` then `chmod`, and the unit's comment now matches the mode it
  is actually given.
- `requirements.txt` gained upper bounds on `requests` and `urllib3` to match
  the one Flask already had, and an honest note that `nvidia-ml-py` installs
  whether or not you have a GPU.

### Looks — the universe, rebuilt from physics

- **The baked assets are regenerated from physical models rather than layered
  noise**, and the generator (`blender/galaxy_assets.py`) is pure NumPy, so a
  fresh bake needs no Blender install. The three galaxy discs are now distinct
  de Vaucouleurs classes with a real bar, dust lanes that spring from the bar
  ends, resolved stars, HII regions and globular clusters; the gas-giant poles
  are circumpolar cyclones instead of the octagonal grey cap that axis-aligned
  Perlin noise produced; the star surface has per-granule brightness instead of
  uniform cells; and the Milky Way sky uses an embedded-source transfer so the
  band glows rather than baking to a black streak. Every texture stays under
  1 MB, and two independent bakes are bit-identical, so the result is
  reproducible.

### Docs

- The README quickstart said `http://localhost:8080`; the app binds `0.0.0.0`.
  Said so, next to the command.
- A new "What is exposed" note under Security names what an unauthenticated
  request returns, rather than leaving it implied.

### Tests

`tests/test_auth_non_ascii.py`, `tests/test_deploy_install.py`,
`tests/test_setup_roundtrip.py`, `tests/test_ipscan.py`,
`tests/test_edge_exporter.py` — each pinned to a failure reproduced first.

## 2.0.0 — the universe release

The public repo had fallen a long way behind the version in the videos. This
release brings it level, and makes the whole thing runnable by someone who is
not its author.

### You can now just run it

- **Demo mode.** `DEMO=1 python3 app.py` renders the complete scene from
  anonymised fixtures: no configuration, no credentials, no network. The
  fixtures drift, and a demo intrusion fires every ~75 s so every layer is
  visible. See [`docs/demo.md`](docs/demo.md).
- **Browser setup wizard** at `/setup`. Starting with nothing configured no
  longer exits — it prints a setup token, serves the wizard, and redirects `/`
  there. Every section has a **Test** button that really connects and reports
  what it found. Save writes `config.json` (`0600`), Apply restarts the process.
- **Configuration layering**: environment > `config.json` > defaults, so the
  wizard and files and env vars coexist instead of competing.
- **Add-ons.** Drop a Python file in `addons/` and it becomes a panel. Failures
  are contained per add-on. Two examples included. This replaces the
  author-specific automation panel that used to be hardcoded.

### The second screen

- **`/nexus`**, a 4K view built to be read across a room and on camera: the
  estate from orbit, with the solar-system network fabric and labelled stars.
- **Lockstep**: the wall publishes its tour position, Nexus follows it and names
  the same subject at the same moment. If the wall is not running, Nexus
  free-roams.
- **Display modes** (`wall`, `showcase`, `ops`, `night`, `alert`) over
  `/api/mode`, including a cinematic showcase flythrough.
- **Presence gating**: with a presence source wired up, both screens stop
  rendering when the room is empty and resume when you walk in.

### The outside world

- **The edge galaxy** — a third galaxy beyond the WAN sun representing everything
  outside: edge locations, viewer countries, autonomous systems.
- **Threats**: CrowdSec decisions and security-monitor findings merge into one
  timeline (`/api/threats` + SSE). A new event streaks in from its country,
  bursts on the shield, names itself, and pulses the room lights red.
- **Audience**: real unique visitors, from Cloudflare zone analytics *or* from
  your own origin access log via the exporter in `deploy/edge/`. Tunnel request
  counters are never presented as viewers.
- **Exosphere**: external flows drawn as beacons by autonomous system and a
  country ring, sized by measured bandwidth.

### Looks

- **Blender-baked assets**, generated by `blender/galaxy_assets.py` and
  committed: a nebula sky, three spiral galaxy discs, planet and star surfaces,
  and a rocket mesh. Rockets ferry measured traffic along the bridge and WAN
  routes.
- Textured planets and sun, a post-processing grade, adaptive supersampling, and
  a label-collision pass that keeps text readable at every camera angle.

### Under the hood

- Topology rebuilt: measured L2 adjacency from the controller, per-link rates,
  flow arcs, active RTT probing with per-host latency baselines, and discovery
  of devices no controller lists.
- New optional sources: Emby/Jellyfin, multiple Ollama instances, Akvorado,
  cloudflared metrics, CrowdSec, a security monitor, Cloudflare analytics.
- `/api/config` tells the front end who this instance is (brand, nodes,
  accents, palette, features, add-ons) so nothing site-specific is baked into
  the JavaScript. Any number of Proxmox nodes is supported, not two.
- Deploy kit: dual-screen kiosk X configuration with EDID recovery, the room
  light driver, the edge exporters, and a Home Assistant presence package.
- Tests and CI: config layering, `/api/config` shape, a demo smoke test, the
  setup token gate, the add-on loader, a secret scan across the working tree and
  all of git history, and a private-address guardrail.

### Removed

- The author's personal automation panel and its poller.
- A hardcoded media-provider health probe.
- DOOM assets are no longer vendored (licensing, and 14 MB). `tools/fetch-doom.sh`
  fetches them locally if you want the easter egg; without them the layer
  disables itself.

## 1.0.0

First public release: Proxmox galaxies, Zabbix problem halos, UniFi clients,
Frigate camera satellites, GPU telemetry, the history sampler, and the HUD
fallback.
