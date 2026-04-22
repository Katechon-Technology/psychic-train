#!/bin/bash
# Run from your dev machine to rsync psychic-train to the game-server and deploy.
# Usage: ./deploy-from-dev.sh [ssh-alias]
# Default SSH alias: psychic-train-game  (set in ~/.ssh/config)
set -euo pipefail

SERVER="${1:-psychic-train-game}"
REMOTE_PATH="/opt/psychic-train"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Deploying psychic-train → game-server ($SERVER) ==="

# 1. Sync repo (excluding gitignored heavy assets)
echo "[1/4] Syncing repo to $SERVER:$REMOTE_PATH ..."
rsync -avz --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='__pycache__' \
    --exclude='.next' \
    --exclude='*.pyc' \
    --exclude='factorio-client/' \
    --exclude='machines/game-server/.env' \
    --exclude='machines/stream-server/.env' \
    "$REPO_ROOT/" \
    "$SERVER:$REMOTE_PATH/"

# 2. Ensure .env exists on the remote
echo "[2/4] Checking .env on remote..."
ssh "$SERVER" "test -f $REMOTE_PATH/machines/game-server/.env || { echo 'ERROR: $REMOTE_PATH/machines/game-server/.env is missing — copy .env.example and fill it in'; exit 1; }"

# 3. Reap any broker-spawned containers from previous runs
echo "[3/4] Reaping broker-spawned containers..."
ssh "$SERVER" "docker ps -q --filter name=env- --filter name=agent- --filter name=stream-client- --filter name=vtuber- | xargs -r docker rm -f || true"

# 4. Run the server-side deploy script
echo "[4/4] Running remote deploy..."
ssh "$SERVER" "bash $REMOTE_PATH/machines/game-server/deploy.sh"

echo "=== Done. ==="
