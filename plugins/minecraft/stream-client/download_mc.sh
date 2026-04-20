#!/bin/bash
# Downloads Minecraft ${MC_VERSION} client JAR + all library JARs into
# /opt/mc-data using Mojang's version manifest API. No Python required.
set -euo pipefail

VERSION=${MC_VERSION:-1.21.11}
DATA=/opt/mc-data
MANIFEST_URL="https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

echo "[mc-dl] fetching version manifest for ${VERSION}"
VERSION_URL=$(curl -sf "$MANIFEST_URL" | jq -r ".versions[] | select(.id==\"${VERSION}\") | .url")
VERSION_JSON=$(curl -sf "$VERSION_URL")

mkdir -p "$DATA/versions/${VERSION}"
echo "$VERSION_JSON" > "$DATA/versions/${VERSION}/${VERSION}.json"

# Client JAR
CLIENT_URL=$(echo "$VERSION_JSON" | jq -r '.downloads.client.url')
echo "[mc-dl] downloading client JAR"
curl -sf -o "$DATA/versions/${VERSION}/${VERSION}.jar" "$CLIENT_URL"

# Library JARs (including natives classifiers)
echo "[mc-dl] downloading libraries"
echo "$VERSION_JSON" | jq -r '
  .libraries[] |
  .downloads |
  ((.artifact // empty), (.classifiers // {} | .["natives-linux"] // empty)) |
  select(.url != null) |
  .url + " " + .path
' | while read -r url path; do
  dest="$DATA/libraries/$path"
  mkdir -p "$(dirname "$dest")"
  [ -f "$dest" ] || curl -sf -o "$dest" "$url"
done

# Asset index + objects (textures, sounds — required for the client to finish loading)
ASSET_INDEX_URL=$(echo "$VERSION_JSON" | jq -r '.assetIndex.url')
ASSET_INDEX_ID=$(echo "$VERSION_JSON" | jq -r '.assetIndex.id')
mkdir -p "$DATA/assets/indexes"
echo "[mc-dl] downloading asset index ${ASSET_INDEX_ID}"
ASSET_INDEX=$(curl -sf "$ASSET_INDEX_URL")
echo "$ASSET_INDEX" > "$DATA/assets/indexes/${ASSET_INDEX_ID}.json"

echo "[mc-dl] downloading asset objects (this may take a while)"
echo "$ASSET_INDEX" | jq -r '.objects | to_entries[] | .value.hash' | while read -r hash; do
  prefix="${hash:0:2}"
  dest="$DATA/assets/objects/$prefix/$hash"
  mkdir -p "$DATA/assets/objects/$prefix"
  [ -f "$dest" ] || curl -sf -o "$dest" "https://resources.download.minecraft.net/$prefix/$hash"
done

# Pre-seed options.txt to skip first-run dialogs (narrator onboarding, tutorial).
cat > "$DATA/options.txt" <<'EOF'
onboardAccessibility:false
tutorialStep:none
EOF

echo "[mc-dl] done — $(du -sh "$DATA" | cut -f1)"
