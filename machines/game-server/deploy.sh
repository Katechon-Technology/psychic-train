#!/bin/bash
# Deployed-from-CI script. Assumes /opt/psychic-train/ contains the synced repo tree
# and /opt/psychic-train/machines/game-server/.env holds the prod env.
set -euo pipefail

cd /opt/psychic-train/machines/game-server

echo "[deploy] pulling latest images..."
docker compose pull broker frontend

echo "[deploy] (re)building on-demand plugin images on this host..."
docker compose -f /opt/psychic-train/dev/docker-compose.yml --profile build build

echo "[deploy] restarting compose stack..."
docker compose up -d --remove-orphans

echo "[deploy] done."
