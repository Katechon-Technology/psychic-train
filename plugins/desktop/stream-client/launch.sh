#!/bin/bash
# Starts the desktop control server (Fastify on $CTRL_HOST:$CTRL_PORT) under the
# Xvfb display set up by stream-client-base. Once the server is listening, kicks
# off seed_layout.sh in the background — that opens the initial browser window,
# a couple of xterms, and a conky status strip so the stream is visually alive
# from second one rather than waiting on the agent's first tool call.
set -euo pipefail
log() { echo "[desktop-launch] $*"; }

: "${CTRL_HOST:=0.0.0.0}"
: "${CTRL_PORT:=8780}"
export HOST="${CTRL_HOST}" PORT="${CTRL_PORT}"
export DISPLAY="${DISPLAY:-:1}"

cd /control-server

# Background job that polls the control server and, once it responds, runs the
# seed layout script. Keeps launch.sh as a single foreground exec so the base
# image's process monitor (LAUNCH_PID) still tracks the right PID.
(
    for _ in $(seq 1 30); do
        if curl -fsS "http://127.0.0.1:${CTRL_PORT}/health" >/dev/null 2>&1; then
            log "control server is up; running seed layout"
            DISPLAY="${DISPLAY}" /app/seed_layout.sh || log "seed layout exited non-zero (non-fatal)"
            break
        fi
        sleep 1
    done
) &

log "starting control server on ${CTRL_HOST}:${CTRL_PORT} display=${DISPLAY}"
exec npx tsx src/server.ts
