#!/bin/bash
# CrowdSec geo/AS export for the Galaxy dashboard. cscli only runs on the
# CrowdSec host and its alert/decision output is the only place the country and
# AS of an attacker exist, so a 1-minute cron writes both lists as JSON into a
# directory nginx serves read-only to the dashboard (galaxy-export-site.conf.example).
# The dashboard reads them as CROWDSEC_EXPORT_URL/alerts.json and /decisions.json.
set -euo pipefail
D=${GALAXY_EXPORT_DIR:-/var/www/galaxy-export}
CSCLI=${CSCLI:-/usr/bin/cscli}
# Point GALAXY_EXPORT_DIR at a directory of its own, never at an existing site
# root: these files list the addresses CrowdSec has decided about, including
# your own if you ever locked yourself out, and the vhost next to this script
# is what restricts who may read them.
mkdir -p -m 0755 "$D"
if "$CSCLI" alerts list -o json -l 200 --since 24h > "$D/.alerts.tmp" 2>/dev/null; then mv "$D/.alerts.tmp" "$D/alerts.json"; fi
if "$CSCLI" decisions list -o json > "$D/.decisions.tmp" 2>/dev/null; then mv "$D/.decisions.tmp" "$D/decisions.json"; fi
chmod 644 "$D"/*.json 2>/dev/null || true
