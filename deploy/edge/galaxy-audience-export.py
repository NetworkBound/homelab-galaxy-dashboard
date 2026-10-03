#!/usr/bin/env python3
"""Unique-viewer summary for the Galaxy dashboard, from the nginx `galaxy` log
(CF-Connecting-IP + CF-IPCountry + host; see galaxy-audience-log.conf).

Runs from cron every minute on the origin and writes audience.json into the
directory nginx serves read-only to the dashboard (galaxy-export-site.conf.example).
The dashboard reads it as AUDIENCE_URL.

"Viewer" = a distinct real client IP that is neither a monitor nor an obvious
bot, seen in the window. Monitors/bots are counted separately, never mixed in.
Private/loopback client addresses (your own LAN hitting the origin directly)
are ignored entirely.
"""
import ipaddress
import json
import os
import re
import time

LOG = os.environ.get("GALAXY_LOG", "/var/log/nginx/galaxy.log")
OUT = os.environ.get("GALAXY_OUT", "/var/www/galaxy-export/audience.json")
MON = re.compile(r"blackbox|uptime|kuma|zabbix|statuscake|pingdom|healthcheck|monitor|gatus", re.I)
BOT = re.compile(r"bot|crawl|spider|scan|curl|wget|python-requests|python-urllib|go-http-client|libwww|httpclient"
                 r"|java/|okhttp|masscan|zgrab|nmap|censys|shodan", re.I)
LINE = re.compile(r'^(\d+(?:\.\d+)?) (\S+) (\S+) (\S+) (\d{3}) "(.*)"$')

# Two of the logged fields are whatever the client said they were. $host is the
# Host header and $http_cf_ipcountry is a plain request header that only means
# anything when the request really came through Cloudflare — anyone who can
# reach the origin directly can put what they like in it. Both end up as
# strings in audience.json and then on the wall, so neither is copied through
# unexamined. (The front end escapes them today; this is so that stays true
# whatever renders them next, and so one junk header cannot crowd the real
# countries out of a twelve-row table.)
CC = re.compile(r"^[A-Za-z]{2}$")
HOSTNAME = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$")


def _country(raw):
    return raw.upper() if CC.match(raw or "") else "??"


def _host(raw):
    return raw.lower() if HOSTNAME.match(raw or "") else "(invalid)"


def _public(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (a.is_private or a.is_loopback or a.is_link_local or a.is_multicast or a.is_unspecified)


def rows(now):
    since = now - 3600
    files = [LOG + ".1", LOG] if os.path.exists(LOG + ".1") else [LOG]
    for f in files:
        try:
            with open(f, errors="replace") as fh:
                for line in fh:
                    m = LINE.match(line.rstrip("\n"))
                    if not m:
                        continue
                    ts = float(m.group(1))
                    if ts < since:
                        continue
                    yield ts, m.group(2), m.group(3), m.group(4), m.group(5), m.group(6)
        except FileNotFoundError:
            pass


def main():
    now = time.time()
    v5, v60, r5, r60 = set(), set(), 0, 0
    cc, hosts, mons, bots = {}, {}, set(), set()
    for ts, ip, country, host, _status, ua in rows(now):
        if not _public(ip):
            continue
        if MON.search(ua):
            mons.add(ip); continue
        if BOT.search(ua):
            bots.add(ip); continue
        r60 += 1; v60.add(ip)
        if now - ts <= 300:
            r5 += 1; v5.add(ip)
        c = cc.setdefault(_country(country), {"ips": set(), "requests": 0})
        c["ips"].add(ip); c["requests"] += 1
        h = hosts.setdefault(_host(host), {"ips": set(), "requests": 0})
        h["ips"].add(ip); h["requests"] += 1
    by_country = sorted(({"cc": k, "uniques": len(v["ips"]), "requests": v["requests"]} for k, v in cc.items()),
                        key=lambda x: (-x["uniques"], -x["requests"]))[:12]
    by_host = sorted(({"host": k, "uniques": len(v["ips"]), "requests": v["requests"]} for k, v in hosts.items()),
                     key=lambda x: (-x["uniques"], -x["requests"]))[:8]
    out = {"up": True, "ts": round(now, 1), "source": "origin-log", "window_s": 3600,
           "viewers_5m": len(v5), "requests_5m": r5, "viewers_1h": len(v60), "requests_1h": r60,
           "by_country": by_country, "by_host": by_host,
           "monitors_1h": len(mons), "bots_1h": len(bots)}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    os.chmod(tmp, 0o644); os.replace(tmp, OUT)


if __name__ == "__main__":
    main()
