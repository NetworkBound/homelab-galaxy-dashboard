"""Shared helpers for the test-suite: a clean environment and a clean module cache."""
import os
import sys

MODULES = ("config", "app", "pollers", "topology", "probe", "edge", "threats", "showtime", "setup", "addons", "demo")
PREFIXES = ("PVE_", "GPUX_", "AISRV_", "SVC_", "FLEET_", "ZBX_", "UNIFI_", "FRIGATE", "OLLAMA", "GRAFANA", "PROM",
            "NETMAP", "NTOPNG", "NP_", "CLOUDFLARED", "CROWDSEC", "AKVORADO", "SECMON", "CF_", "AUDIENCE", "EMBY",
            "ENABLE_", "LIGHTS_", "PRESENCE_", "ALERT_", "UI_", "TOPOLOGY_", "AI_", "ADDON", "DEMO")
SINGLES = ("LISTEN_HOST", "LISTEN_PORT", "POLL_INTERVAL", "METRICS_DB", "HISTORY_DAYS", "SETUP_UI", "SETUP_TOKEN",
           "CONFIG_FILE", "DATA_DIR", "BRAND", "DOMAIN", "TAGLINE", "WAN_LABEL")


def clear_modules():
    for name in MODULES:
        sys.modules.pop(name, None)


def clean_env():
    for key in list(os.environ):
        if key.startswith(PREFIXES) or key in SINGLES:
            os.environ.pop(key, None)
