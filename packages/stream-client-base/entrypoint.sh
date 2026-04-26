#!/bin/bash
# Base entrypoint for psychic-train stream-client images.
#
# Flow:
#   1. Xvfb on $DISPLAY
#   2. openbox window manager
#   3. exec /app/launch.sh (provided by the kind-specific child image)
#   4. ffmpeg x11grab -> /tmp/hls/stream.m3u8
#   5. nginx (serves HLS on :3000 with an embedded hls.js player at /)
#   6. wait on critical processes

set -euo pipefail

log() { echo "[stream-client-base] $*"; }
fail() { echo "[stream-client-base] ERROR: $*" >&2; exit 1; }

DISPLAY_WIDTH="${DISPLAY_WIDTH:-1280}"
DISPLAY_HEIGHT="${DISPLAY_HEIGHT:-720}"
DISPLAY_FPS="${DISPLAY_FPS:-30}"
DISPLAY="${DISPLAY:-:1}"

# Make `hostname` resolve. Docker's libnetwork sometimes hasn't populated
# /etc/hosts yet by the time the JVM's static init runs InetAddress.getLocalHost(),
# which on glibc blocks on getaddrinfo timeouts and stacks tens of seconds onto
# Minecraft startup — pushing past the broker's readiness window.
grep -q " $(hostname)\$" /etc/hosts || echo "127.0.1.1 $(hostname)" >> /etc/hosts

mkdir -p /tmp/hls /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix

log "Starting Xvfb on ${DISPLAY} ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24"
Xvfb "${DISPLAY}" -screen 0 "${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24" -ac -nolisten tcp +extension RANDR &
XVFB_PID=$!

ELAPSED=0
until DISPLAY="${DISPLAY}" xdpyinfo >/dev/null 2>&1; do
    [ "$ELAPSED" -ge 120 ] && fail "X display not ready after 120s"
    sleep 1; ELAPSED=$((ELAPSED+1))
done
log "X display ready (${ELAPSED}s)"

DISPLAY="${DISPLAY}" openbox-session &
OPENBOX_PID=$!
sleep 1

[ -x /app/launch.sh ] || fail "/app/launch.sh not found or not executable — the child image must provide one"

log "Executing /app/launch.sh (kind-specific launcher)..."
DISPLAY="${DISPLAY}" /app/launch.sh &
LAUNCH_PID=$!

# Give the kind-specific payload a chance to produce a first frame before we start
# encoding — some clients (e.g. Factorio) take several seconds to render anything.
WARMUP="${STREAM_WARMUP_SECONDS:-8}"
log "Sleeping ${WARMUP}s for kind launcher warmup..."
sleep "${WARMUP}"

log "Starting FFmpeg HLS encoder (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}@${DISPLAY_FPS})"
ffmpeg -loglevel warning \
    -f x11grab -framerate "${DISPLAY_FPS}" -video_size "${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}" \
    -draw_mouse 0 -i "${DISPLAY}" \
    -vcodec libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p \
    -g 60 -sc_threshold 0 \
    -f hls -hls_time 2 -hls_list_size 5 \
    -hls_flags delete_segments+append_list \
    -hls_segment_filename '/tmp/hls/seg%05d.ts' \
    /tmp/hls/stream.m3u8 &
FFMPEG_PID=$!

ELAPSED=0
until [ -f /tmp/hls/stream.m3u8 ]; do
    [ "$ELAPSED" -ge 60 ] && fail "HLS manifest not produced after 60s"
    sleep 1; ELAPSED=$((ELAPSED+1))
done
log "HLS manifest ready (${ELAPSED}s)"

cleanup() {
    log "Shutting down..."
    kill "${FFMPEG_PID}" 2>/dev/null || true
    kill "${LAUNCH_PID}" 2>/dev/null || true
    kill "${OPENBOX_PID}" 2>/dev/null || true
    kill "${XVFB_PID}" 2>/dev/null || true
    nginx -s quit 2>/dev/null || true
}
trap cleanup SIGTERM SIGINT

log "Starting nginx..."
nginx

log "Stream ready at http://localhost:3000/stream.m3u8"

while true; do
    kill -0 "${XVFB_PID}" 2>/dev/null || { log "Xvfb exited"; cleanup; exit 1; }
    kill -0 "${FFMPEG_PID}" 2>/dev/null || { log "FFmpeg exited"; cleanup; exit 1; }
    kill -0 "${LAUNCH_PID}" 2>/dev/null || { log "Kind launcher exited"; cleanup; exit 1; }
    sleep 5
done
