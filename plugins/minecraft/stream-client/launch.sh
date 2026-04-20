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
NATIVES_DIR="/tmp/mc-natives"
mkdir -p "$NATIVES_DIR"

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
  --gameDir "$MC_DATA_DIR" \
  --assetsDir "$MC_DATA_DIR/assets" \
  --quickPlayPath /tmp/quickplay.log \
  --quickPlayMultiplayer "${MC_HOST}:${MC_PORT}" \
  --width "$DISPLAY_WIDTH" \
  --height "$DISPLAY_HEIGHT"
