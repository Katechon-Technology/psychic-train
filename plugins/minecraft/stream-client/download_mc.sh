#!/bin/bash
# Downloads Minecraft ${MC_VERSION} client JAR + all library JARs into
# /opt/mc-data using Mojang's version manifest API. No Python required.
set -euo pipefail

VERSION=${MC_VERSION:-1.21.11}
DATA=${MC_DATA_DIR:-/opt/mc-data}
MANIFEST_URL="https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

# Atomic per-file download: write to <dest>.tmp first, rename on success. A
# previous build that timed out mid-transfer would otherwise leave a partial
# file at <dest>, and the `[ -f "$dest" ]` skip check below would happily
# accept it on the next run, leading to a corrupt JAR / asset.
fetch() {
    local dest="$1" url="$2"
    if [ -f "$dest" ] && [ -s "$dest" ]; then
        return 0
    fi
    rm -f "$dest" "$dest.tmp"
    "${CURL[@]}" -o "$dest.tmp" "$url"
    mv "$dest.tmp" "$dest"
}

# Curl flags. The original script used plain `curl -sf` — no timeout, no
# retry. That's fine on a healthy link but hangs forever on a stalled
# connection. We add the minimum to (a) abort genuinely-dead connections
# (--speed-time/--speed-limit) and (b) survive transient blips
# (--retry/--retry-all-errors). NO --max-time: a slow-but-steady download
# of the ~25MB client JAR on a residential link is fine and shouldn't be
# capped — that was an earlier mistake.
#
#   --connect-timeout 15      abandon hopeless DNS / TCP handshakes after 15s
#   --speed-time 30
#   --speed-limit 1024        if the connection drops below 1KB/s for 30s, abort
#                             this attempt — catches truly stalled connections
#                             without punishing slow ones
#   --retry 3 --retry-delay 4 --retry-all-errors
#                             handle transient errors; on persistent failure
#                             the script aborts and the user reruns the build,
#                             which resumes from the BuildKit cache mount.
CURL=(curl -fsS \
        --retry 3 --retry-delay 4 --retry-all-errors \
        --connect-timeout 15 \
        --speed-time 30 --speed-limit 1024)

echo "[mc-dl] fetching version manifest for ${VERSION}"
VERSION_URL=$("${CURL[@]}" "$MANIFEST_URL" | jq -r ".versions[] | select(.id==\"${VERSION}\") | .url")
VERSION_JSON=$("${CURL[@]}" "$VERSION_URL")

mkdir -p "$DATA/versions/${VERSION}"
echo "$VERSION_JSON" > "$DATA/versions/${VERSION}/${VERSION}.json"

# Client JAR
CLIENT_URL=$(echo "$VERSION_JSON" | jq -r '.downloads.client.url')
echo "[mc-dl] downloading client JAR"
fetch "$DATA/versions/${VERSION}/${VERSION}.jar" "$CLIENT_URL"

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
  fetch "$dest" "$url"
done

# Asset index + objects (textures, sounds — required for the client to finish loading)
ASSET_INDEX_URL=$(echo "$VERSION_JSON" | jq -r '.assetIndex.url')
ASSET_INDEX_ID=$(echo "$VERSION_JSON" | jq -r '.assetIndex.id')
mkdir -p "$DATA/assets/indexes"
echo "[mc-dl] downloading asset index ${ASSET_INDEX_ID}"
ASSET_INDEX=$("${CURL[@]}" "$ASSET_INDEX_URL")
echo "$ASSET_INDEX" > "$DATA/assets/indexes/${ASSET_INDEX_ID}.json"

echo "[mc-dl] downloading asset objects (this may take a while)"
# THE rate-limiting step. ~3,800 separate HTTPS GETs to Mojang's asset CDN —
# most files are tiny so total time is dominated by per-request latency, not
# bandwidth. We parallelize with xargs -P so the per-request overhead
# overlaps; on a typical home connection this cuts ~30 min serial down to
# ~2 min. mkdir of all the prefix dirs happens up front so concurrent fetches
# don't race on the same parent directory.
echo "$ASSET_INDEX" | jq -r '.objects | to_entries[] | .value.hash' \
    | awk '{print substr($0,1,2)}' | sort -u \
    | while read -r prefix; do mkdir -p "$DATA/assets/objects/$prefix"; done

export DATA
export -f fetch
# Inline the curl flags so the subshell that xargs spawns sees them. Bash
# can't directly export an array, hence the flat string.
export MC_CURL_FLAGS='-fsS --retry 3 --retry-delay 4 --retry-all-errors --connect-timeout 15 --speed-time 30 --speed-limit 1024'

echo "$ASSET_INDEX" | jq -r '.objects | to_entries[] | .value.hash' \
    | xargs -n1 -P4 -I{} bash -c '
        hash="$1"
        prefix="${hash:0:2}"
        dest="$DATA/assets/objects/$prefix/$hash"
        if [ -f "$dest" ] && [ -s "$dest" ]; then exit 0; fi
        rm -f "$dest" "$dest.tmp"
        # shellcheck disable=SC2086 # word splitting on $MC_CURL_FLAGS is intentional
        curl $MC_CURL_FLAGS -o "$dest.tmp" "https://resources.download.minecraft.net/$prefix/$hash" \
            && mv "$dest.tmp" "$dest"
    ' _ {}

# Pre-seed options.txt to skip first-run dialogs (narrator onboarding, tutorial).
cat > "$DATA/options.txt" <<'EOF'
onboardAccessibility:false
tutorialStep:none
EOF

echo "[mc-dl] done — $(du -sh "$DATA" | cut -f1)"
