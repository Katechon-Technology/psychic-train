#!/bin/bash
# Starts the playwright-browser Fastify server on $PW_HOST:$PW_PORT.
# Chromium is launched lazily by Playwright on the first POST /session call;
# it opens inside this container's Xvfb display, which is what ffmpeg is capturing.
set -euo pipefail
log() { echo "[pw-launch] $*"; }

: "${PW_HOST:=0.0.0.0}"
: "${PW_PORT:=8731}"
export HOST="${PW_HOST}" PORT="${PW_PORT}"

cd /pw-browser
log "Starting playwright-browser server on ${PW_HOST}:${PW_PORT}"
exec npx tsx src/server.ts
