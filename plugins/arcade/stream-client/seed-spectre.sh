#!/usr/bin/env bash
# Mirror the katechon-app SPECTRE source into plugin-data/arcade/spectre/, the
# host-side staging dir read by the arcade-spectre-init compose service. The
# init service then copies it into the psychic_train_arcade_spectre named
# volume, which the arcade-stream-client mounts read-only at /app/spectre.
#
# Re-run this whenever SPECTRE upstream changes. The source is NOT in the
# docker build context — that's intentional: CI doesn't have access to the
# katechon-app repo, and only the deps (spectre-requirements.txt, committed)
# need to be at build time.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default sibling-repo layout: katechon/{psychic-train,katechon-app}/. The
# path is "$HERE/../../../../katechon-app/applications/SPECTRE":
#   $HERE = .../psychic-train/plugins/arcade/stream-client
#   ../../../..             = .../katechon
SRC="${SPECTRE_SRC:-$HERE/../../../../katechon-app/applications/SPECTRE}"

# Repo root = $HERE/../../..
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
DST="$REPO_ROOT/plugin-data/arcade/spectre"
COMMITTED_REQS="$HERE/spectre-requirements.txt"

if [ ! -d "$SRC" ]; then
    echo "SPECTRE source not found at: $SRC" >&2
    echo "Set SPECTRE_SRC=/path/to/SPECTRE to override." >&2
    exit 1
fi

mkdir -p "$DST"
rsync -a --delete \
    --exclude '.git' \
    --exclude '.venv' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    "$SRC/" "$DST/"

echo "seeded SPECTRE → $DST"

# Keep the committed deps snapshot (used at image build time) in sync with
# upstream. If this changes, commit spectre-requirements.txt before the next
# CI deploy or the built image will run on stale deps.
if [ -f "$SRC/requirements.txt" ]; then
    if ! cmp -s "$SRC/requirements.txt" "$COMMITTED_REQS" 2>/dev/null; then
        cp -f "$SRC/requirements.txt" "$COMMITTED_REQS"
        echo
        echo "  NOTE: $COMMITTED_REQS was updated from upstream."
        echo "  Commit the change before the next deploy so CI builds with the new deps."
    fi
fi

echo
echo "Next:"
echo "  cd dev && docker compose --profile init run --rm arcade-spectre-init"
