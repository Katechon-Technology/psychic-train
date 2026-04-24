#!/bin/bash
# Starts an RTMP fan-out FFmpeg that reads this container's own HLS output
# (served by nginx on localhost:3000) and pushes to YouTube. Uses `-vcodec
# copy` so there's no re-encoding cost — the HLS stream is already H.264+AAC
# from the main FFmpeg that composites avatar + source.
#
# PID is written to /tmp/rtmp.pid so stop-rtmp.sh can kill it cleanly.

set -euo pipefail

if [ -f /tmp/rtmp.pid ] && kill -0 "$(cat /tmp/rtmp.pid)" 2>/dev/null; then
    echo "RTMP already running (pid=$(cat /tmp/rtmp.pid))"
    exit 0
fi

OUTPUTS=()
[ -n "${YOUTUBE_STREAM_KEY:-}" ] && OUTPUTS+=("rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}")

if [ ${#OUTPUTS[@]} -eq 0 ]; then
    echo "No stream key configured (YOUTUBE_STREAM_KEY)" >&2
    exit 1
fi

OUTPUT_ARGS=()
for url in "${OUTPUTS[@]}"; do
    OUTPUT_ARGS+=("-map" "0:v" "-map" "0:a" "-vcodec" "copy" "-acodec" "aac" "-ar" "44100" "-b:a" "128k" "-f" "flv" "$url")
done

# Read this container's local HLS output (produced by the main FFmpeg in
# entrypoint.sh) and fan it out.
nohup ffmpeg -loglevel warning \
    -re -i http://localhost:3000/stream.m3u8 \
    "${OUTPUT_ARGS[@]}" \
    </dev/null >/tmp/rtmp.log 2>&1 &

RTMP_PID=$!
echo $RTMP_PID > /tmp/rtmp.pid
echo "RTMP push started (pid=$RTMP_PID, targets=${#OUTPUTS[@]})"
