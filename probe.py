"""probe.py - active ICMP measurement and LAN discovery for the galaxy dashboard.

Everything else in this dashboard is PASSIVE: it asks Proxmox, UniFi, Zabbix and
ntopng what they already know. That leaves two blind spots this module closes.

  1 LATENCY   nothing else measures host-to-host reachability. fping gives real
              RTT / jitter / loss per node, which the 3D scene maps onto each
              node and its uplink.
  2 DISCOVERY UniFi only lists what has associated with it, and Proxmox only
              lists its own guests. Anything else - a device on a dumb switch,
              a static-IP appliance, a box someone just plugged in - is
              invisible to both. A periodic sweep of the subnets we already
              know about finds it without any config to maintain.

WHY fping AND NOT nping: nping is one target per invocation with unstructured
output; fanning it out over ~100 hosts is a lot of processes for a lot of text
scraping, and it reads like a slow scan. fping was built for exactly this - one
process, all targets in parallel, one summary line each.

ICMP SILENCE IS NOT DEATH. Windows Firewall drops echo requests by default, so
a perfectly healthy PC answers no ping at all. The NIC still answers ARP -
that happens below the firewall and cannot be turned off while the host is on
the segment - so an ARP entry carrying a MAC is proof of life that ICMP cannot
give us. States with a lladdr (REACHABLE/STALE/DELAY/PROBE) mean present;
FAILED/INCOMPLETE mean genuinely absent. This is only ever used to UPGRADE a
silent host to "present", never to mark anything down: it is L2-local, so hosts
on another subnet legitimately have no entry.

HONESTY RULES (same as the rest of the codebase):
  * a host that did not answer gets loss=100 and rtt=None. Never rtt=0.
  * a host we have not probed yet is absent from the map, not present-with-zero.
  * the sweep reports only addresses that actually answered ICMP.

SAFETY: the sweep only ever touches subnets derived from addresses the
dashboard already knows about - it cannot wander off this network. Target
counts are capped, fping is run with an explicit timeout, and every failure
mode degrades to "no probe data" rather than taking the poller down.

Optional: enabled with ``ENABLE_PROBE=true``; needs the ``fping`` binary.
"""

import ipaddress
import re
import shutil
import subprocess
import threading
import time

PROBE_S = 20          # RTT sweep of known nodes
SWEEP_S = 300         # discovery sweep of the whole subnet
MAX_TARGETS = 512     # bound the command line and the runtime
MAX_SUBNETS = 4       # /24s we are willing to sweep
FPING = shutil.which("fping") or "/usr/bin/fping"

DATA = {}

# fping -q summary line, e.g. "<ip> : xmt/rcv/%loss = 3/3/0%, min/avg/max = 0.19/0.20/0.21"
_LINE = re.compile(
    r"^(\S+)\s*:\s*xmt/rcv/%loss\s*=\s*(\d+)/(\d+)/(\d+)%"
    r"(?:,\s*min/avg/max\s*=\s*([\d.]+)/([\d.]+)/([\d.]+))?")

_state = {
    "rtt": {},        # ip -> {"rtt","jitter","loss","ts"}
    "arp": {},        # ip -> mac, for hosts answering ARP but not ICMP
    "alive": {},      # ip -> last time it answered the discovery sweep
    "ts": 0.0,
    "sweep_ts": 0.0,
    "subnets": [],
    "up": False,
    "err": None,
}


def _run(args, timeout):
    """fping writes its per-host summary to stderr and exits non-zero when any
    target is unreachable, which is the normal case here - so we read both
    streams and ignore the exit code."""
    try:
        p = subprocess.run([FPING] + args, capture_output=True, text=True, timeout=timeout)
        return (p.stdout or "") + (p.stderr or "")
    except subprocess.TimeoutExpired:
        _state["err"] = "fping timed out"
        return ""
    except FileNotFoundError:
        _state["err"] = "fping not installed"
        return ""
    except Exception as e:
        _state["err"] = f"{type(e).__name__}: {e}"
        return ""


_ARP_ALIVE = re.compile(r"^(\S+)\s+dev\s+\S+\s+lladdr\s+(\S+)\s+(.*)$")
_ARP_DEAD = ("FAILED", "INCOMPLETE")


def arp_present():
    """IPs on this segment whose NIC is answering ARP, whatever ICMP says.

    Read after the ping sweep on purpose: a failed ping still forces the kernel
    to (re)resolve, so a host that has actually left drops to FAILED rather than
    lingering in STALE from an old cache entry.
    """
    out = {}
    try:
        p = subprocess.run(["ip", "neigh", "show"], capture_output=True, text=True, timeout=8)
    except Exception as e:
        _state["err"] = f"ip neigh: {type(e).__name__}"
        return out
    for line in (p.stdout or "").splitlines():
        m = _ARP_ALIVE.match(line.strip())
        if not m:
            continue
        ip, mac, rest = m.group(1), m.group(2), m.group(3).upper()
        if any(d in rest for d in _ARP_DEAD):
            continue
        try:
            ipaddress.IPv4Address(ip)
        except ValueError:
            continue
        out[ip] = mac.lower()
    return out


def _node_ips():
    """Every routable IPv4 the current topology knows about.

    Returns (all, sourced). `sourced` excludes the disc: nodes this module's own
    sweep created - without that split the two feed back into each other: a
    sweep finds an unknown host, topology publishes it as a node, the next
    sweep sees it in the node list and calls it known, topology drops it, and
    it flaps in and out of the scene on every tick.
    """
    topo = (DATA.get("topology") or {})
    every, sourced = [], []
    for n in topo.get("nodes") or []:
        ip = n.get("ip")
        if not ip:
            continue
        try:
            a = ipaddress.IPv4Address(str(ip))
        except ValueError:
            continue
        if a.is_loopback or a.is_multicast or a.is_unspecified:
            continue
        every.append(str(a))
        if not str(n.get("id") or "").startswith("disc:"):
            sourced.append(str(a))
    return sorted(set(every)), sorted(set(sourced))


def _subnets(ips):
    """The /24s our own nodes live in. Derived, never configured: a new VLAN
    starts being swept as soon as one node in it shows up, and we can never
    scan a network this dashboard has no business touching."""
    seen = {}
    for ip in ips:
        try:
            net = ipaddress.IPv4Network(ip + "/24", strict=False)
        except ValueError:
            continue
        if not net.network_address.is_private:
            continue
        seen[str(net)] = seen.get(str(net), 0) + 1
    # busiest subnets first, so the cap keeps the ones that matter
    return [s for s, _ in sorted(seen.items(), key=lambda kv: -kv[1])][:MAX_SUBNETS]


def probe_rtt(ips):
    """3 pings each, 400 ms timeout, 40 ms apart. One process for all targets."""
    if not ips:
        return {}
    out = {}
    txt = _run(["-c", "3", "-t", "400", "-p", "40", "-q"] + ips[:MAX_TARGETS],
               timeout=max(20, len(ips) * 0.05 + 15))
    now = time.time()
    for line in txt.splitlines():
        m = _LINE.match(line.strip())
        if not m:
            continue
        ip, xmt, rcv, loss = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
        rec = {"loss": loss, "sent": xmt, "recv": rcv, "ts": now, "rtt": None, "jitter": None}
        if m.group(5) and rcv:
            lo, avg, hi = float(m.group(5)), float(m.group(6)), float(m.group(7))
            rec["rtt"] = round(avg, 2)
            rec["jitter"] = round(hi - lo, 2)
        out[ip] = rec
    return out


def sweep(subnets):
    """Who is actually alive out there, including things no controller lists."""
    alive = {}
    now = time.time()
    for cidr in subnets:
        txt = _run(["-g", cidr, "-a", "-q", "-r", "0", "-t", "250"], timeout=90)
        for line in txt.splitlines():
            ip = line.strip().split()[0] if line.strip() else ""
            try:
                ipaddress.IPv4Address(ip)
            except ValueError:
                continue
            alive[ip] = now
    return alive


def _tick(now, do_sweep):
    ips, sourced = _node_ips()
    if ips:
        rtt = probe_rtt(ips)
        if rtt:
            _state["rtt"] = rtt
            _state["ts"] = now
            _state["up"] = True
            _state["err"] = None

    if do_sweep:
        subs = _subnets(ips)
        _state["subnets"] = subs
        if subs:
            found = sweep(subs)
            if found:
                _state["alive"] = found
                _state["sweep_ts"] = now

    # ARP is read AFTER probe_rtt() so the failed pings have already forced
    # re-resolution; a host that really left is FAILED by now, not STALE.
    _state["arp"] = arp_present()

    # alive, answering ICMP, and in nothing the dashboard actually polls: this
    # is the "something new got spun up" signal, and it needs no config to
    # notice. Compared against SOURCED addresses only - see _node_ips().
    known = set(sourced)
    unknown = sorted(ip for ip in _state["alive"] if ip not in known)

    DATA["probe"] = {
        "rtt": _state["rtt"],
        "arp": _state.get("arp") or {},
        "unknown": unknown[:64],
        "unknown_count": len(unknown),
        "subnets": _state["subnets"],
        "ts": _state["ts"],
        "sweep_ts": _state["sweep_ts"],
        "up": _state["up"],
        "err": _state["err"],
        "targets": len(ips),
    }


def poll_probe():
    last_sweep = 0.0
    time.sleep(12)     # let the topology poller publish a node list before the first probe
    while True:
        try:
            now = time.time()
            do_sweep = (now - last_sweep) >= SWEEP_S
            _tick(now, do_sweep)
            if do_sweep:
                last_sweep = now
        except Exception as e:
            print("[probe]", e, flush=True)
        time.sleep(PROBE_S)


def start_probe(data=None):
    """Launch the prober as a daemon thread (mirror of start_topology_poller)."""
    global DATA
    if data is not None:
        DATA = data
    DATA.setdefault("probe", None)
    if not shutil.which(FPING) and not shutil.which("fping"):
        print("[probe] fping not found - active probing disabled", flush=True)
        DATA["probe"] = {"up": False, "err": "fping not installed", "rtt": {}, "unknown": [], "unknown_count": 0}
        return
    threading.Thread(target=poll_probe, daemon=True, name="probe").start()
    print("[probe] started", flush=True)
