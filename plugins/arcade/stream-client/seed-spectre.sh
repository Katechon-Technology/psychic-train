#!/usr/bin/env bash
# Mirror the katechon-app SPECTRE source into the arcade stream-client build
# context. The vendored copy is gitignored — re-run this whenever SPECTRE
# upstream changes (or before a fresh stream-client build).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default sibling-repo layout: katechon/{psychic-train,katechon-app}/. The
# path is "$HERE/../../../../katechon-app/applications/SPECTRE":
#   $HERE = .../psychic-train/plugins/arcade/stream-client
#   ../../../..             = .../katechon
SRC="${SPECTRE_SRC:-$HERE/../../../../katechon-app/applications/SPECTRE}"

if [ ! -d "$SRC" ]; then
    echo "SPECTRE source not found at: $SRC" >&2
    echo "Set SPECTRE_SRC=/path/to/SPECTRE to override." >&2
    exit 1
fi

mkdir -p "$HERE/spectre"
# --exclude README.md so we don't clobber the committed marker README that
# acts as a .gitkeep for the COPY path.
rsync -a --delete \
    --exclude '.git' \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude 'README.md' \
    "$SRC/" "$HERE/spectre/"

# Upstream's README is renamed to UPSTREAM_README.md so it's still readable
# inside the container if useful, without overwriting our marker.
if [ -f "$SRC/README.md" ]; then
    cp -f "$SRC/README.md" "$HERE/spectre/UPSTREAM_README.md"
fi

echo "seeded SPECTRE → $HERE/spectre/"
