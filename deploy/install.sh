#!/usr/bin/env bash
#
# Install the Homelab Galaxy Dashboard as a systemd service.
#
#   sudo ./deploy/install.sh
#
# Creates a dedicated unprivileged service account, a virtualenv, a root-owned
# 0640 environment file readable only by that account, and the systemd unit.
# Safe to re-run: it upgrades an existing install in place and never overwrites
# your environment file. Note that it does replace everything under
# ${INSTALL_DIR}, so keep local add-ons somewhere else and point ADDONS_DIR at
# them.
#
set -euo pipefail

APP_NAME="homelab-galaxy-dashboard"
APP_USER="dashboard"
INSTALL_DIR="/opt/${APP_NAME}"
CONFIG_DIR="/etc/${APP_NAME}"
STATE_DIR="/var/lib/${APP_NAME}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
    echo "This script must run as root (try: sudo $0)" >&2
    exit 1
fi

echo "==> Installing ${APP_NAME} from ${SRC_DIR}"

# --- service account -------------------------------------------------------
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    echo "==> Creating service account '${APP_USER}'"
    useradd --system --no-create-home --shell /usr/sbin/nologin "${APP_USER}"
else
    echo "==> Service account '${APP_USER}' already exists"
fi

# --- directories -----------------------------------------------------------
install -d -o root       -g root       -m 0755 "${INSTALL_DIR}"
# The setup wizard writes config.json here (as the service account), so the
# directory belongs to it; the env file stays root-owned and group-readable.
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${CONFIG_DIR}"
install -d -o "${APP_USER}" -g "${APP_USER}" -m 0750 "${STATE_DIR}"

# --- application code ------------------------------------------------------
# Every top-level module by glob, never a hand-written list. A list is a thing
# that goes stale: auth.py was added to the application and not to the list, so
# a fresh install copied an app.py whose first job is `import auth`, crashed
# with ModuleNotFoundError, and Restart=always turned that into a crash loop
# that never served a page. tests/test_deploy_install.py now asserts the
# installed tree can import what app.py imports.
echo "==> Copying application"
shopt -s nullglob
for item in "${SRC_DIR}"/*.py; do
    name="$(basename "${item}")"
    rm -rf "${INSTALL_DIR:?}/${name}"
    cp "${item}" "${INSTALL_DIR}/"
done
shopt -u nullglob
for item in requirements.txt templates static addons demo; do
    [[ -e "${SRC_DIR}/${item}" ]] || continue
    rm -rf "${INSTALL_DIR:?}/${item}"
    cp -r "${SRC_DIR}/${item}" "${INSTALL_DIR}/"
done

# Fail here, not in a restart loop five seconds from now: every module app.py
# imports that lives beside it in the source tree must have landed in the
# install tree.
missing=""
for mod in $(grep -oP '^\s*(?:import|from)\s+\K[A-Za-z_][A-Za-z0-9_]*' "${SRC_DIR}/app.py" | sort -u); do
    [[ -f "${SRC_DIR}/${mod}.py" ]] || continue          # stdlib or third party: pip's problem
    [[ -f "${INSTALL_DIR}/${mod}.py" ]] || missing+=" ${mod}.py"
done
if [[ -n "${missing}" ]]; then
    echo "==> FAILED: app.py imports modules that were not installed:${missing}" >&2
    exit 1
fi

# --- virtualenv ------------------------------------------------------------
if [[ ! -d "${INSTALL_DIR}/.venv" ]]; then
    echo "==> Creating virtualenv"
    python3 -m venv "${INSTALL_DIR}/.venv"
fi
echo "==> Installing Python dependencies"
"${INSTALL_DIR}/.venv/bin/pip" install --quiet --upgrade pip
"${INSTALL_DIR}/.venv/bin/pip" install --quiet -r "${INSTALL_DIR}/requirements.txt"

# --- configuration ---------------------------------------------------------
# Never clobber an existing env file — it holds the operator's credentials.
if [[ ! -f "${CONFIG_DIR}/env" ]]; then
    echo "==> Seeding ${CONFIG_DIR}/env from .env.example"
    # install(1), not cp: this file grows credentials the moment the operator
    # edits it, and cp would create it world-readable for the instant before
    # the chmod below.
    install -o root -g "${APP_USER}" -m 0640 "${SRC_DIR}/.env.example" "${CONFIG_DIR}/env"
    NEEDS_CONFIG=1
else
    echo "==> Keeping existing ${CONFIG_DIR}/env"
    NEEDS_CONFIG=0
fi
chown root:"${APP_USER}" "${CONFIG_DIR}/env"
chmod 0640 "${CONFIG_DIR}/env"

# Point runtime state at the state dir and the wizard's file at the config dir,
# unless the operator already set them.
if grep -qs '^METRICS_DB=metrics.db$' "${CONFIG_DIR}/env"; then
    sed -i "s|^METRICS_DB=metrics.db$|METRICS_DB=${STATE_DIR}/metrics.db|" "${CONFIG_DIR}/env"
fi
grep -qs '^DATA_DIR='    "${CONFIG_DIR}/env" || echo "DATA_DIR=${STATE_DIR}" >> "${CONFIG_DIR}/env"
grep -qs '^CONFIG_FILE=' "${CONFIG_DIR}/env" || echo "CONFIG_FILE=${CONFIG_DIR}/config.json" >> "${CONFIG_DIR}/env"

# --- systemd ---------------------------------------------------------------
echo "==> Installing systemd unit"
install -m 0644 "${SRC_DIR}/deploy/homelab-dashboard.service" \
    /etc/systemd/system/homelab-dashboard.service
systemctl daemon-reload

if [[ ${NEEDS_CONFIG} -eq 1 ]]; then
    cat <<EOF

==> Installed, but NOT started. Two ways to configure it:

    a) The browser wizard. Start the service, read the token, open /setup:

        sudo systemctl enable --now homelab-dashboard
        sudo journalctl -u homelab-dashboard | grep 'setup. token'
        # then http://<this host>:8080/setup -> saves ${CONFIG_DIR}/config.json (0600)

    b) The environment file (fill in the PVE_0_* block):

        sudoedit ${CONFIG_DIR}/env
        sudo systemctl enable --now homelab-dashboard

    Either way: sudo systemctl status homelab-dashboard

EOF
else
    echo "==> Restarting service"
    systemctl enable homelab-dashboard
    systemctl restart homelab-dashboard
    sleep 2
    systemctl --no-pager --lines=10 status homelab-dashboard || true
fi
