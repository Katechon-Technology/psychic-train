#!/bin/bash
# Launches the Factorio GUI client connecting to $SERVER_HOST:$SERVER_PORT.
# Runs inside stream-client-base's Xvfb display ($DISPLAY).
#
# /opt/factorio is a read-only Docker volume seeded by `factorio-client-init`,
# but Factorio wants to write lockfiles + possibly rename libsteam_api.so, so
# we copy the install into /tmp/factorio-client (writable tmpfs) on first run.
# Pattern is borrowed from claudetorio's start-factorio.sh.

set -euo pipefail
log() { echo "[factorio-launch] $*"; }
fail() { echo "[factorio-launch] ERROR: $*" >&2; exit 1; }

: "${SERVER_HOST:?SERVER_HOST is required}"
: "${SERVER_PORT:?SERVER_PORT is required}"

SOURCE_DIR="${FACTORIO_SOURCE_DIR:-/opt/factorio}"
RUNTIME_DIR="/tmp/factorio-client"
CONFIG_DIR="/tmp/factorio-data"
RUNTIME_CONFIG_INI="${CONFIG_DIR}/config.ini"

mkdir -p "${CONFIG_DIR}/saves" "${CONFIG_DIR}/mods" "${CONFIG_DIR}/script-output"

if [ ! -x "${SOURCE_DIR}/bin/x64/factorio" ]; then
    fail "Factorio binary missing at ${SOURCE_DIR}/bin/x64/factorio — populate plugins/factorio/factorio-client/ on the host and run: docker compose --profile init run --rm factorio-client-init"
fi

# Copy the install into a writable tmpfs so lockfiles, steam lib rename, etc.
# don't fail against the read-only mount.
log "copying Factorio install into ${RUNTIME_DIR}..."
rm -rf "${RUNTIME_DIR}"
mkdir -p "${RUNTIME_DIR}"
cp -a "${SOURCE_DIR}/." "${RUNTIME_DIR}/"
FACTORIO_DIR="${RUNTIME_DIR}"

cat > "${RUNTIME_CONFIG_INI}" <<EOF
[path]
read-data=${FACTORIO_DIR}/data
write-data=${CONFIG_DIR}
EOF

# Disable Steam API (would otherwise try to relaunch via Steam).
if [ -f "${FACTORIO_DIR}/lib/libsteam_api.so" ]; then
    mv "${FACTORIO_DIR}/lib/libsteam_api.so" "${FACTORIO_DIR}/lib/libsteam_api.so.disabled" 2>/dev/null || true
fi

log "Connecting Factorio client to ${SERVER_HOST}:${SERVER_PORT}"
exec "${FACTORIO_DIR}/bin/x64/factorio" \
    --mp-connect "${SERVER_HOST}:${SERVER_PORT}" \
    -c "${RUNTIME_CONFIG_INI}"
