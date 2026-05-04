#!/bin/bash
set -euo pipefail

cd /opt/psychic-train/machines/stream-server

echo "[deploy] pulling stream-agent image..."
docker compose pull stream-agent

echo "[deploy] rebuilding stream-client + vtuber images on this host..."
docker compose -f /opt/psychic-train/dev/docker-compose.yml --profile build build \
  stream-client-base \
  vtuber-overlay \
  factorio-stream-client \
  playwright-browser-stream-client \
  minecraft-stream-client \
  arcade-stream-client

echo "[deploy] restarting compose..."
docker compose up -d --remove-orphans

echo "[deploy] done."
