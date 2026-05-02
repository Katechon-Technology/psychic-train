#!/bin/bash
# psychic-train vtuber-overlay entrypoint.
#
# 1. Xvfb on $DISPLAY_NUM (default :99 to avoid collision with :1 reserved for
#    plugin stream-clients)
# 2. PulseAudio + virtual_speaker null sink for TTS capture
# 3. Render /wrapper.html via envsubst using $BROKER_URL — wrapper.html
#    polls broker /api/stream/current-source for the live session URL and
#    swaps hls.js source at runtime
# 4. Open-LLM-VTuber server on :12393 with generated conf.yaml
# 5. Narrator sidecar polling broker for the active session
# 6. Python HTTP server on :3001 serving wrapper.html + hls.js
# 7. Chromium kiosk → http://localhost:3001/
# 8. FFmpeg x11grab + PulseAudio → HLS at /tmp/hls/stream.m3u8
# 9. nginx on :3000 serves /stream.m3u8 (same pattern as stream-client-base)
# 10. RTMP push to YouTube (if YOUTUBE_STREAM_KEY) — kicked off ONCE at
#     boot and runs forever, regardless of which session is currently
#     being overlaid.

set -euo pipefail

log() { echo "[vtuber-overlay] $*"; }
fail() { echo "[vtuber-overlay] ERROR: $*" >&2; exit 1; }

# Persistent vtuber: SOURCE_STREAM_URL is no longer required at boot. The
# wrapper.html polls $BROKER_URL/api/stream/current-source at runtime and
# swaps hls.js source on session switches; RTMP to YouTube stays connected
# the whole time.
: "${BROKER_URL:?BROKER_URL is required — e.g. http://broker:8080}"

DISPLAY_NUM="${DISPLAY_NUM:-:99}"
DISPLAY_WIDTH="${DISPLAY_WIDTH:-1920}"
DISPLAY_HEIGHT="${DISPLAY_HEIGHT:-1080}"
DISPLAY_FPS="${DISPLAY_FPS:-30}"
VTUBER_AUDIO_DEBUG="${VTUBER_AUDIO_DEBUG:-0}"
# When 1, run the full compositing pipeline: open Chromium on wrapper.html,
# capture it with FFmpeg, serve HLS via nginx on :3000, and (if
# YOUTUBE_STREAM_KEY is set) push RTMP. When 0 (default), only the avatar
# server on :12393 + narrator run, and the browser embeds :12393/embed.html
# directly.
ENABLE_RECORDING="${ENABLE_RECORDING:-0}"

# envsubst-friendly exports (wrapper + conf templates use these)
export CHARACTER_NAME="${CHARACTER_NAME:-Kat}"
export LIVE2D_MODEL="${LIVE2D_MODEL:-mao_pro}"
export VOICE_ID="${VOICE_ID:-jqcCZkN6Knx8BJ5TBdYR}"
# Default persona ported from katechon-demo/server.js:247-251 — same Kat that
# runs the voice command path on /demo. The narrator role is broader than
# routing transcripts (it commentates on whatever the active workspace is
# doing), so the prompt is trimmed to describe Kat's voice + personality.
export PERSONA_PROMPT="$(echo "${PERSONA_PROMPT:-You are Kat, the VTuber agent watching an autonomous AI run on a remote Linux desktop. Snappy, real reactions, no cringe, 1-2 sentences at a time.}" | tr '\n' ' ')"
export BROKER_URL
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export ELEVENLABS_API_KEY="${ELEVENLABS_API_KEY:-}"
export GROQ_API_KEY="${GROQ_API_KEY:-}"

export XDG_RUNTIME_DIR=/run/user/0
mkdir -p "$XDG_RUNTIME_DIR" /tmp/.X11-unix /tmp/chrome-profile /tmp/hls /var/www/html
chmod 1777 /tmp/.X11-unix

# A stale Xvfb lockfile (from a crashed previous boot of the same container,
# possible because compose's `restart: unless-stopped` reuses /tmp) makes the
# next Xvfb start fail with "Server is already active for display 99". Wipe.
DISPLAY_NUM_NUMERIC="${DISPLAY_NUM#:}"
rm -f "/tmp/.X${DISPLAY_NUM_NUMERIC}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM_NUMERIC}" 2>/dev/null || true

XVFB_PID=""; PULSE_PID=""; VTUBER_PID=""; CHROME_PID=""
HTTP_PID=""; FFMPEG_PID=""; NARRATE_PID=""

cleanup() {
    log "shutting down..."
    # Kill any RTMP push first (best effort)
    if [ -f /tmp/rtmp.pid ]; then
        kill -INT "$(cat /tmp/rtmp.pid 2>/dev/null)" 2>/dev/null || true
        rm -f /tmp/rtmp.pid
    fi
    for pid in "$NARRATE_PID" "$FFMPEG_PID" "$CHROME_PID" "$HTTP_PID" "$VTUBER_PID"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    pulseaudio --kill 2>/dev/null || true
    [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null || true
    nginx -s quit 2>/dev/null || true
}
trap cleanup SIGTERM SIGINT

# ---------- audio diagnostics (ported from claudetorio) ----------
audio_diag_snapshot() {
    local label="$1"
    log "audio diag (${label}): pactl info"
    pactl info || true
    log "audio diag (${label}): sinks"
    pactl list short sinks || true
    log "audio diag (${label}): sources"
    pactl list short sources || true
}

audio_diag_sink_inputs() {
    local label="$1"
    log "audio diag (${label}): sink-inputs"
    pactl list short sink-inputs || true
}

audio_diag_poll_sink_inputs() {
    local rounds="${1:-8}" interval="${2:-2}" found=0 i
    for i in $(seq 1 "$rounds"); do
        local out
        out="$(pactl list short sink-inputs 2>/dev/null || true)"
        if [ -n "$out" ]; then
            found=1
            log "audio diag (sink-inputs poll ${i}/${rounds}):"
            printf '%s\n' "$out"
        else
            log "audio diag (sink-inputs poll ${i}/${rounds}): none"
        fi
        sleep "$interval"
    done
    [ "$found" -eq 0 ] && log "WARNING: Chrome is not writing audio to PulseAudio (no sink-inputs found)"
}

audio_diag_probe_monitor() {
    [ "$VTUBER_AUDIO_DEBUG" = "1" ] || return 0
    log "audio diag: probing virtual_speaker.monitor for signal (ffmpeg astats)"
    timeout 6 ffmpeg -hide_banner -loglevel info \
        -f pulse -i virtual_speaker.monitor \
        -t 3 -af astats=metadata=1:reset=1 -f null - \
        >/tmp/vtuber-audio-probe.log 2>&1 || true
    sed -n '1,200p' /tmp/vtuber-audio-probe.log || true
}

# ---------- 1. Xvfb ----------
log "Xvfb $DISPLAY_NUM ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}"
Xvfb "$DISPLAY_NUM" -screen 0 "${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24" +extension GLX -ac &
XVFB_PID=$!
ELAPSED=0
until DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; do
    [ "$ELAPSED" -ge 60 ] && fail "X display not ready"
    sleep 1; ELAPSED=$((ELAPSED+1))
done
log "X ready"

# ---------- 2. PulseAudio ----------
log "PulseAudio..."
pulseaudio --kill 2>/dev/null || true
sleep 1
pulseaudio --start --exit-idle-time=-1 --log-level=error 2>/dev/null || true
ELAPSED=0
until pactl info >/dev/null 2>&1; do
    [ "$ELAPSED" -ge 20 ] && fail "PulseAudio not ready"
    sleep 1; ELAPSED=$((ELAPSED+1))
done
pactl load-module module-null-sink sink_name=virtual_speaker \
    sink_properties=device.description=VirtualSpeaker >/dev/null 2>&1 || true
pactl set-default-sink virtual_speaker >/dev/null 2>&1 || true
pactl set-default-source virtual_speaker.monitor >/dev/null 2>&1 || true
audio_diag_snapshot "post-pulse-setup"

# ---------- 2b. ASR models ----------
if [ -d /models-src ] && [ "$(ls -A /models-src 2>/dev/null)" ]; then
    log "Copying ASR models from /models-src..."
    cp -r /models-src/. /app/vtuber/models/
fi

# ---------- 3. conf.yaml ----------
log "rendering conf.yaml.template..."
# Select TTS backend: ElevenLabs when key is set, free edge_tts otherwise.
if [ -n "${ELEVENLABS_API_KEY}" ]; then
    export TTS_MODEL="elevenlabs_tts"
    log "TTS: elevenlabs (voice=${VOICE_ID})"
else
    export TTS_MODEL="edge_tts"
    log "TTS: edge_tts fallback (no ELEVENLABS_API_KEY)"
fi
envsubst < /conf.yaml.template > /app/vtuber/conf.yaml

# ---------- 4. Open-LLM-VTuber server ----------
if [ -n "${ANTHROPIC_API_KEY}" ]; then
    log "starting Open-LLM-VTuber server on :12393..."
    cd /app/vtuber && DISPLAY="$DISPLAY_NUM" uv run run_server.py &
    VTUBER_PID=$!
    ELAPSED=0
    VTUBER_READY_TIMEOUT="${VTUBER_READY_TIMEOUT:-360}"
    until curl -sf http://localhost:12393/ >/dev/null 2>&1; do
        kill -0 "$VTUBER_PID" 2>/dev/null || fail "VTuber server exited early"
        [ "$ELAPSED" -ge "$VTUBER_READY_TIMEOUT" ] && fail "VTuber server not ready after ${VTUBER_READY_TIMEOUT}s"
        sleep 2; ELAPSED=$((ELAPSED+2))
    done
    log "VTuber server ready (${ELAPSED}s)"
else
    log "ANTHROPIC_API_KEY not set — skipping avatar server + narrator"
fi

# ---------- 5. Narrator sidecar ----------
if [ -n "${ANTHROPIC_API_KEY}" ]; then
    log "starting narrator..."
    python3 /narrate.py >> /tmp/narrator.log 2>&1 &
    NARRATE_PID=$!
fi

# ---------- 6. HTTP server for wrapper.html ----------
log "rendering wrapper.html..."
envsubst < /wrapper.html > /var/www/html/index.html
log "serving wrapper on :3001..."
cd /var/www/html && python3 -m http.server 3001 >/dev/null 2>&1 &
HTTP_PID=$!

if [ "$ENABLE_RECORDING" != "1" ]; then
    log "ENABLE_RECORDING=0 — Chromium / FFmpeg / nginx / RTMP skipped. Avatar UI on :12393."
    while true; do
        kill -0 "$XVFB_PID" 2>/dev/null || { log "Xvfb died"; cleanup; exit 1; }
        if [ -n "$VTUBER_PID" ]; then
            kill -0 "$VTUBER_PID" 2>/dev/null || { log "VTuber server died"; cleanup; exit 1; }
        fi
        sleep 5
    done
fi

# ---------- 7. Chromium kiosk ----------
log "Chromium kiosk -> http://localhost:3001/"
rm -rf /tmp/chrome-profile/GpuCache /tmp/chrome-profile/ShaderCache
unset DBUS_SESSION_BUS_ADDRESS || true
DISPLAY="$DISPLAY_NUM" google-chrome-stable \
    --no-sandbox --no-first-run --no-default-browser-check \
    --use-gl=angle --use-angle="${ANGLE_BACKEND:-swiftshader}" \
    --ignore-gpu-blocklist --enable-webgl --disable-dev-shm-usage \
    --ozone-platform=x11 --start-fullscreen --kiosk \
    --autoplay-policy=no-user-gesture-required \
    --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
    --disable-infobars \
    --window-size="${DISPLAY_WIDTH},${DISPLAY_HEIGHT}" \
    --window-position=0,0 \
    --user-data-dir=/tmp/chrome-profile \
    http://localhost:3001/ &
CHROME_PID=$!

log "waiting ${STREAM_WARMUP_SECONDS:-10}s for Chromium render..."
sleep "${STREAM_WARMUP_SECONDS:-10}"
audio_diag_sink_inputs "after-chrome-start"
if [ "$VTUBER_AUDIO_DEBUG" = "1" ]; then
    audio_diag_poll_sink_inputs 10 2
    audio_diag_probe_monitor
fi

# ---------- 8. FFmpeg — HLS output only. RTMP is started on demand via
# /scripts/start-rtmp.sh (invoked by the broker through stream-agent) which
# spawns a *separate* FFmpeg reading our own HLS and re-muxing (vcodec copy) to
# Twitch/Kick. Keeps viewers' preview alive whether RTMP is running or not. ---
log "starting FFmpeg (HLS only; RTMP is toggled via /scripts/start-rtmp.sh)..."
ffmpeg -loglevel warning \
    -thread_queue_size 1024 \
    -f x11grab -framerate "$DISPLAY_FPS" -video_size "${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}" -draw_mouse 0 -i "$DISPLAY_NUM" \
    -thread_queue_size 1024 \
    -f pulse -i virtual_speaker.monitor \
    -map 0:v -map 1:a \
    -vcodec libx264 -preset ultrafast -tune zerolatency \
    -pix_fmt yuv420p -g 60 -sc_threshold 0 -b:v 3000k \
    -acodec aac -ar 44100 -b:a 128k \
    -f hls -hls_time 2 -hls_list_size 5 \
    -hls_flags delete_segments+append_list \
    -hls_segment_filename /tmp/hls/seg%05d.ts \
    /tmp/hls/stream.m3u8 &
FFMPEG_PID=$!

# Wait for first HLS manifest
ELAPSED=0
until [ -f /tmp/hls/stream.m3u8 ]; do
    [ "$ELAPSED" -ge 60 ] && fail "HLS manifest not produced after 60s"
    sleep 1; ELAPSED=$((ELAPSED+1))
done
log "HLS manifest ready"

# ---------- 9. nginx ----------
log "starting nginx on :3000..."
nginx

log "=== vtuber-overlay ready: http://localhost:3000/stream.m3u8 ==="

# ---------- 10. RTMP push (boot-time, persistent) ----------
# YouTube ingest is one-shot: every reconnect requires a manual Go Live
# (or "auto-start" which YouTube silently disables after each session).
# Kicking the RTMP side-car ONCE at boot — and never stopping it — means
# YouTube only needs Go Live one time, ever.
if [ -n "${YOUTUBE_STREAM_KEY:-}" ]; then
    log "kicking off RTMP push to YouTube..."
    /scripts/start-rtmp.sh || log "WARNING: start-rtmp.sh exited non-zero (RTMP not running)"
else
    log "YOUTUBE_STREAM_KEY not set — skipping RTMP push (HLS preview only)"
fi

# ---------- 11. monitor ----------
while true; do
    kill -0 "$XVFB_PID" 2>/dev/null   || { log "Xvfb died"; cleanup; exit 1; }
    kill -0 "$FFMPEG_PID" 2>/dev/null || { log "FFmpeg died"; cleanup; exit 1; }
    sleep 5
done
