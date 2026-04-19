#!/bin/bash
# Start the prismarine-viewer spectator bot, then open Chromium in kiosk mode at
# its HTTP URL inside the Xvfb display. ffmpeg (from stream-client-base) captures
# the Chromium window.
set -euo pipefail
log() { echo "[mc-launch] $*"; }

: "${MC_HOST:?MC_HOST is required}"
: "${MC_PORT:?MC_PORT is required}"
: "${DISPLAY:=:1}"

VIEWER_PORT="${VIEWER_PORT:-3007}"
export VIEWER_PORT MC_HOST MC_PORT VIEWER_USERNAME VIEW_DISTANCE

cd /viewer
node prismarine-viewer-bot.mjs &
VIEWER_PID=$!

# Wait for prismarine-viewer to respond on its port.
for i in $(seq 1 60); do
    if curl -sf "http://127.0.0.1:${VIEWER_PORT}/" >/dev/null 2>&1; then
        log "viewer ready after ${i}s"
        break
    fi
    sleep 1
done

CHROME=$(command -v chromium || command -v chromium-browser || true)
[ -n "$CHROME" ] || { echo "[mc-launch] chromium binary not found" >&2; exit 1; }

log "opening chromium kiosk at http://127.0.0.1:${VIEWER_PORT}/"
exec "$CHROME" \
    --kiosk \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --user-data-dir=/tmp/chrome-profile \
    --window-size="${DISPLAY_WIDTH:-1280},${DISPLAY_HEIGHT:-720}" \
    "http://127.0.0.1:${VIEWER_PORT}/"
