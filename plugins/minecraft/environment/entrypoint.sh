#!/bin/bash
set -euo pipefail
cd /srv/minecraft

JAR=$(ls fabric-server-mc.*.jar 2>/dev/null | head -n1 || true)
if [ -z "${JAR}" ]; then
    echo "[mc-env] ERROR: no fabric-server-mc.*.jar found in /srv/minecraft. Populate plugins/minecraft/server/ on the host before starting." >&2
    exit 1
fi
echo "[mc-env] launching ${JAR}"
exec java -Xmx2G -Xms1G -jar "${JAR}" nogui
