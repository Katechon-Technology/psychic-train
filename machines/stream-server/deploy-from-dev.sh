#!/bin/bash
# Run from your dev machine to rsync psychic-train to the stream-server and deploy.
# Usage: ./deploy-from-dev.sh [ssh-alias]
# Default SSH alias: psychic-train-stream  (set in ~/.ssh/config)
set -euo pipefail

SERVER="${1:-psychic-train-stream}"
REMOTE_PATH="/opt/psychic-train"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Deploying psychic-train → stream-server ($SERVER) ==="

# 1. Sync repo
echo "[1/3] Syncing repo to $SERVER:$REMOTE_PATH ..."
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
echo "[2/3] Checking .env on remote..."
ssh "$SERVER" "test -f $REMOTE_PATH/machines/stream-server/.env || { echo 'ERROR: $REMOTE_PATH/machines/stream-server/.env is missing — copy .env.example and fill it in'; exit 1; }"

# 3. Run the server-side deploy script
echo "[3/3] Running remote deploy..."
ssh "$SERVER" "bash $REMOTE_PATH/machines/stream-server/deploy.sh"

echo "=== Done. ==="
