# Demo mode

```bash
DEMO=1 python3 app.py     # → http://localhost:8080 and http://localhost:8080/nexus
```

No configuration is read, no validation runs, no poller starts and nothing
touches the network. Every endpoint the two screens use is served from
`demo/fixtures/`, so a fresh clone renders the complete scene — galaxies, the
solar-system fabric, the edge galaxy, threats, viewers, rockets — on a laptop
with no homelab behind it.

It exists for three reasons: to let you see the thing before handing it
credentials, to take screenshots that expose nothing, and to give the front-end
tests a fixed, realistic dataset.

## What it serves

`install()` in [`demo.py`](../demo.py) registers the routes that `showtime.py`
and `threats.py` normally own, with the same contracts, and loads the fixtures
into the same `DATA` dictionary the pollers would fill. The front end cannot
tell the difference.

| Fixture | Feeds |
|---|---|
| `all.json` | `/api/all` — 89 guests across two nodes, storage, pools, ZFS, Zabbix, UniFi, health, certs, telemetry, edge, add-ons |
| `topology.json` | `/api/topology` — 136 nodes, 135 links, 30 flows, measured rates |
| `showtime.json` | `/api/showtime` — Ollama instances, Frigate, media sessions, GPU series |
| `threats.json` | `/api/threats` and its stream — the intrusion timeline |
| `gpu.json`, `telemetry.json`, `inventory.json` | the matching endpoints |
| `history_net.json`, `history_gpu.json` | `/api/history`, re-based so the newest sample is "now" |
| `lightstate.json`, `mode.json`, `presence.json` | the tour position, display mode, presence |

## It is alive, not a snapshot

A background thread drifts the fixtures every few seconds so the scene behaves
like a real one: guest CPU wanders, node load breathes, link and WAN throughput
swell on a slow cycle, GPU utilisation follows a sine with noise, viewer counts
move, and the history series grow. Two things happen on their own timers:

- a **demo intrusion** roughly every 75 seconds (`DEMO_THREAT_EVERY=0` disables
  it, or set it to any number of seconds), which drives the full beat: the red
  streak, the shield burst, the caption, and the light-state pulse;
- the pulse heartbeat both screens share, so they stay in step.

Fire one on demand:

```bash
curl -X POST http://localhost:8080/api/threats/demo
```

Add-ons are skipped in demo mode (they would poll real services); set
`DEMO_ADDONS=1` if you are developing one. The fixtures include two sample
add-on panels so the ADD-ONS layout is visible either way.

## Where the fixtures came from

They are a real estate's API responses, captured once and then rewritten. The
generator is not in this repo — it holds the mapping from real names to fake
ones — but the transformation it applies is:

1. every domain becomes `example.com`;
2. node names become `pve1`, `pve2` — in ids and paths too (`pve:<node>`,
   `guest:<node>:<vmid>`, `host:pve:<node>`), so the graph stays self-consistent;
3. all 89 guest names become generic service names of the same category, and
   the same substitution is applied inside problem texts and labels;
4. clients, infrastructure and the ISP go through an explicit table
   (`living-room-tv`, `Core Switch`, `ISP`, ...);
5. private IPv4 is remapped into `10.0.x.y` **consistently**, so a host has the
   same address everywhere it appears; public IPv4 becomes `203.0.113.x` /
   `198.51.100.x` (the documentation ranges), IPv6 becomes `2001:db8::x`, and
   every MAC is regenerated in the locally-administered `02:` range;
6. anything personal that survived — usernames, media titles, stream sources —
   is replaced;
7. a **leak scan** then refuses to write the output if any pattern from the
   private set still matches.

Structure, counts, relationships and the shape of every number are preserved,
because that is what makes the demo a useful test: the same 89 guests in the
same categories, the same graph depth, the same flow distribution.

If you want to regenerate fixtures from *your own* estate — for a screenshot, or
to reproduce a layout bug with your topology — capture them yourself:

```bash
for ep in all topology showtime gpu threats telemetry inventory; do
  curl -s "http://localhost:8080/api/$ep" > demo/fixtures/$ep.json
done
```

and then **read them before sharing**. They will contain your addresses.
