#!/bin/bash
set -euo pipefail
log() { echo "[mc-launch] $*"; }

: "${MC_HOST:?MC_HOST is required}"
: "${MC_PORT:?MC_PORT is required}"
: "${VIEWER_USERNAME:=Spectator}"
: "${MC_VERSION:=1.21.11}"
: "${MC_DATA_DIR:=/opt/mc-data}"
: "${DISPLAY_WIDTH:=1280}"
: "${DISPLAY_HEIGHT:=720}"

VERSION_JSON="$MC_DATA_DIR/versions/$MC_VERSION/$MC_VERSION.json"

# Hard-fail with a clear pointer to the README if the named volume hasn't been
# seeded. Otherwise the Java classpath fails 30s later with an obscure error.
if [ ! -f "$VERSION_JSON" ]; then
    log "FATAL: $VERSION_JSON missing. The psychic_train_minecraft_client volume"
    log "       hasn't been seeded. On the host, populate plugin-data/minecraft/"
    log "       (see plugin-data/minecraft/README.md), then run:"
    log "         docker compose --profile init run --rm minecraft-client-init"
    exit 1
fi

NATIVES_DIR="/tmp/mc-natives"
mkdir -p "$NATIVES_DIR"

# Writable runtime dir for Minecraft. /opt/mc-data is mounted read-only (it's
# shared across sessions and reseeded only via minecraft-client-init), but the
# client writes to gameDir at startup: downloads/, crash-reports/, logs/,
# options.txt, screenshots/. Point --gameDir at a per-container tmpfs scratch
# and let --assetsDir + the -cp jars continue to read from MC_DATA_DIR.
GAME_DIR="/tmp/mc-runtime"
mkdir -p "$GAME_DIR/downloads" "$GAME_DIR/crash-reports" \
         "$GAME_DIR/logs" "$GAME_DIR/screenshots"
[ -f "$MC_DATA_DIR/options.txt" ] && cp -f "$MC_DATA_DIR/options.txt" "$GAME_DIR/options.txt"

# Offline UUID: MD5 of "OfflinePlayer:<username>" with version 3 + variant bits set.
raw=$(printf 'OfflinePlayer:%s' "$VIEWER_USERNAME" | md5sum | cut -d' ' -f1)
b6=$(printf '%02x' $(( (16#${raw:12:2} & 16#0f) | 16#30 )))
b8=$(printf '%02x' $(( (16#${raw:16:2} & 16#3f) | 16#80 )))
OFFLINE_UUID="${raw:0:8}-${raw:8:4}-${b6}${raw:14:2}-${b8}${raw:18:2}-${raw:20:12}"

log "extracting LWJGL natives"
jq -r '
  .libraries[] | .downloads |
  (.classifiers // {} | .["natives-linux"] // empty) |
  select(.path != null) | .path
' "$VERSION_JSON" | while read -r path; do
  jar="$MC_DATA_DIR/libraries/$path"
  [ -f "$jar" ] && unzip -qo "$jar" "*.so" -d "$NATIVES_DIR" 2>/dev/null || true
done

log "building classpath"
CP="$MC_DATA_DIR/versions/$MC_VERSION/$MC_VERSION.jar"
while IFS= read -r path; do
  jar="$MC_DATA_DIR/libraries/$path"
  [ -f "$jar" ] && CP="$CP:$jar"
done < <(jq -r '.libraries[] | .downloads.artifact | select(.) | .path' "$VERSION_JSON")

MAIN_CLASS=$(jq -r '.mainClass' "$VERSION_JSON")
log "launching $MC_VERSION as $VIEWER_USERNAME → $MC_HOST:$MC_PORT"

exec java \
  -Xmx2G -Xms512M \
  -Djava.library.path="$NATIVES_DIR" \
  -cp "$CP" \
  "$MAIN_CLASS" \
  --username "$VIEWER_USERNAME" \
  --accessToken 0 \
  --uuid "$OFFLINE_UUID" \
  --version "$MC_VERSION" \
  --gameDir "$GAME_DIR" \
  --assetsDir "$MC_DATA_DIR/assets" \
  --quickPlayPath /tmp/quickplay.log \
  --quickPlayMultiplayer "${MC_HOST}:${MC_PORT}" \
  --width "$DISPLAY_WIDTH" \
  --height "$DISPLAY_HEIGHT"
