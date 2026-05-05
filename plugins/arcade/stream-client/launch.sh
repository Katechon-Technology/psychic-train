#!/bin/bash
# Arcade stream-client launcher.
#
# Brings up four X11 workspaces under one Xvfb display:
#   wks 0 — Hub Chromium loading file:///app/hub.html
#   wks 1 — Java Minecraft client connected to MC_HOST:MC_PORT as Spectator
#   wks 2 — Playwright fastify (port PW_PORT) — its first session call lands a
#           Chromium window here
#   wks 3 — SPECTRE Flask dashboard (port SPECTRE_PORT) + a kiosk Chromium
#           pointed at http://127.0.0.1:${SPECTRE_PORT}/?kiosk=1
#
# All four windows are open from t=0 so workspace switches are instant. The
# broker tells us to switch by `docker exec ... wmctrl -s N`. ffmpeg in the
# base image captures the whole Xvfb root window, so the user sees only the
# currently active desktop.
#
# Stays foregrounded via `wait` so the base entrypoint's process monitor sees
# this script alive for the lifetime of the container.

set -euo pipefail
log() { echo "[arcade-launch] $*"; }

: "${DISPLAY:=:1}"
: "${DISPLAY_WIDTH:=1280}"
: "${DISPLAY_HEIGHT:=720}"
: "${MC_HOST:?MC_HOST is required}"
: "${MC_PORT:?MC_PORT is required}"
: "${MC_VERSION:=1.21.1}"
: "${VIEWER_USERNAME:=Spectator}"
: "${MC_DATA_DIR:=/opt/mc-data}"
: "${CTRL_HOST:=0.0.0.0}"
: "${CTRL_PORT:=8780}"
: "${PW_HOST:=0.0.0.0}"
: "${PW_PORT:=8731}"
: "${SPECTRE_HOST:=0.0.0.0}"
: "${SPECTRE_PORT:=5050}"

export DISPLAY

mkdir -p /tmp/hub-profile /tmp/pw-profile /tmp/spectre-profile /workspace

# ---- arcade control server (foreground-ish) -------------------------------
log "starting control server on ${CTRL_HOST}:${CTRL_PORT}"
(
    cd /control-server
    HOST="${CTRL_HOST}" PORT="${CTRL_PORT}" exec npx tsx src/server.ts
) &
CTRL_PID=$!

# ---- playwright fastify (port PW_PORT) ------------------------------------
log "starting playwright fastify on ${PW_HOST}:${PW_PORT}"
(
    cd /pw-browser
    HOST="${PW_HOST}" PORT="${PW_PORT}" exec npx tsx src/server.ts
) &
PW_PID=$!

# ---- SPECTRE Flask (port SPECTRE_PORT) ------------------------------------
# Self-driving OSINT dashboard. Has no Claude agent — ffmpeg captures the
# Chromium kiosk pointed at it (workspace 3). Source is mounted from the
# psychic_train_arcade_spectre volume at /app/spectre; venv with deps is baked
# in the image at /opt/spectre-venv.
SPECTRE_SRC="${SPECTRE_SRC:-/app/spectre}"
SPECTRE_VENV="${SPECTRE_VENV:-/opt/spectre-venv}"
if [ ! -f "${SPECTRE_SRC}/app.py" ]; then
    log "WARNING: ${SPECTRE_SRC}/app.py missing — SPECTRE workspace will be blank."
    log "  Seed the psychic_train_arcade_spectre volume:"
    log "  docker compose --profile init run --rm arcade-spectre-init"
    SPECTRE_PID=0
else
    log "starting SPECTRE Flask on ${SPECTRE_HOST}:${SPECTRE_PORT} (src=${SPECTRE_SRC})"
    (
        cd "${SPECTRE_SRC}"
        SPECTRE_HOST="${SPECTRE_HOST}" SPECTRE_PORT="${SPECTRE_PORT}" \
            exec "${SPECTRE_VENV}/bin/python3" app.py
    ) >/tmp/spectre.log 2>&1 &
    SPECTRE_PID=$!
fi

# ---- Hub Chromium on workspace 0 ------------------------------------------
log "launching Hub Chromium → workspace 0"
(
    # Try chromium via several common command names. Playwright's bundled
    # Chrome is at ~/.cache/ms-playwright/chromium-*/chrome-linux/chrome but
    # dpkg-installed `chromium` works too on Ubuntu 22.04 (universe).
    if command -v chromium >/dev/null; then C=chromium
    elif command -v chromium-browser >/dev/null; then C=chromium-browser
    elif command -v google-chrome >/dev/null; then C=google-chrome
    else
        # Fall back to the playwright-bundled chromium.
        C=$(find /root/.cache/ms-playwright -name chrome -type f 2>/dev/null | head -1)
    fi
    [ -n "$C" ] || { echo "no chromium binary found"; exit 1; }
    exec "$C" \
        --user-data-dir=/tmp/hub-profile \
        --no-first-run \
        --no-default-browser-check \
        --disable-gpu \
        --no-sandbox \
        --disable-dev-shm-usage \
        --window-name=ArcadeHub \
        --class=ArcadeHub \
        --start-maximized \
        --window-size="${DISPLAY_WIDTH},${DISPLAY_HEIGHT}" \
        --window-position=0,0 \
        --kiosk \
        "file:///app/hub.html"
) &
HUB_PID=$!

# ---- Java Minecraft client on workspace 1 ---------------------------------
log "launching Minecraft client → workspace 1 (target=${MC_HOST}:${MC_PORT})"
(
    VERSION_JSON="${MC_DATA_DIR}/versions/${MC_VERSION}/${MC_VERSION}.json"
    if [ ! -f "${VERSION_JSON}" ]; then
        echo "[arcade-launch] WARNING: ${VERSION_JSON} missing — Minecraft workspace will be blank."
        echo "[arcade-launch]   Seed the psychic_train_minecraft_client volume:"
        echo "[arcade-launch]   docker compose --profile init run --rm minecraft-client-init"
        exit 0  # don't kill arcade; Hub + Playwright still work
    fi
    NATIVES_DIR="/tmp/mc-natives"
    mkdir -p "${NATIVES_DIR}"

    # /opt/mc-data is mounted read-only — Minecraft writes to gameDir at
    # startup so we redirect it at a writable tmpfs path. Assets + classpath
    # continue to be read directly from MC_DATA_DIR.
    GAME_DIR="/tmp/mc-runtime"
    mkdir -p "${GAME_DIR}/downloads" "${GAME_DIR}/crash-reports" \
             "${GAME_DIR}/logs" "${GAME_DIR}/screenshots"
    [ -f "${MC_DATA_DIR}/options.txt" ] && cp -f "${MC_DATA_DIR}/options.txt" "${GAME_DIR}/options.txt"

    # Offline UUID derivation (same as the minecraft plugin's launch.sh).
    raw=$(printf 'OfflinePlayer:%s' "${VIEWER_USERNAME}" | md5sum | cut -d' ' -f1)
    b6=$(printf '%02x' $(( (16#${raw:12:2} & 16#0f) | 16#30 )))
    b8=$(printf '%02x' $(( (16#${raw:16:2} & 16#3f) | 16#80 )))
    OFFLINE_UUID="${raw:0:8}-${raw:8:4}-${b6}${raw:14:2}-${b8}${raw:18:2}-${raw:20:12}"

    jq -r '
      .libraries[] | .downloads |
      (.classifiers // {} | .["natives-linux"] // empty) |
      select(.path != null) | .path
    ' "${VERSION_JSON}" | while read -r path; do
      jar="${MC_DATA_DIR}/libraries/${path}"
      [ -f "$jar" ] && unzip -qo "$jar" "*.so" -d "${NATIVES_DIR}" 2>/dev/null || true
    done

    CP="${MC_DATA_DIR}/versions/${MC_VERSION}/${MC_VERSION}.jar"
    while IFS= read -r path; do
      jar="${MC_DATA_DIR}/libraries/${path}"
      [ -f "$jar" ] && CP="${CP}:${jar}"
    done < <(jq -r '.libraries[] | .downloads.artifact | select(.) | .path' "${VERSION_JSON}")

    MAIN_CLASS=$(jq -r '.mainClass' "${VERSION_JSON}")
    exec java \
        -Xmx2G -Xms512M \
        -Djava.library.path="${NATIVES_DIR}" \
        -cp "${CP}" \
        "${MAIN_CLASS}" \
        --username "${VIEWER_USERNAME}" \
        --accessToken 0 \
        --uuid "${OFFLINE_UUID}" \
        --version "${MC_VERSION}" \
        --gameDir "${GAME_DIR}" \
        --assetsDir "${MC_DATA_DIR}/assets" \
        --quickPlayPath /tmp/quickplay.log \
        --quickPlayMultiplayer "${MC_HOST}:${MC_PORT}" \
        --width "${DISPLAY_WIDTH}" \
        --height "${DISPLAY_HEIGHT}"
) >/tmp/mc-client.log 2>&1 &
MC_PID=$!

# ---- Open initial Playwright tab on workspace 2 ---------------------------
# Playwright Chromium is launched lazily by the fastify server on the first
# /session POST. We trigger that here (after a short delay so the server is
# up); the agent will then drive the same session normally. The session id
# returned by /session is a UUID-shaped string — capture it and pass it
# through to /navigate so the initial page actually loads. Hard-coding "0"
# (an earlier version of this script) silently 404s and leaves Chromium on
# about:blank.
#
# Also publishes the launched Chromium's parent PID to /tmp/pw-chrome-pid so
# the window-to-workspace watcher can pin the playwright window by PID — the
# previous catch-all rule ("any chromium-classed window not labeled
# ArcadeHub/ArcadeSpectre goes to desktop 2") was leaking the SPECTRE error
# Chromium onto the Playwright workspace whenever `--class=ArcadeSpectre`
# wasn't honored by the bundled Chromium build.
PW_PROFILE_FOR_PIN="${PLAYWRIGHT_BROWSER_PROFILE:-/tmp/pw-profile}"
log "scheduling initial Playwright session"
(
    for _ in $(seq 1 60); do
        if curl -fsS "http://127.0.0.1:${PW_PORT}/health" >/dev/null 2>&1 \
           || curl -fsS "http://127.0.0.1:${PW_PORT}/" >/dev/null 2>&1; then
            sid=$(curl -fsS -X POST "http://127.0.0.1:${PW_PORT}/session" \
                -H 'content-type: application/json' \
                -d '{}' 2>/dev/null \
                | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
            if [ -n "$sid" ]; then
                curl -fsS -X POST "http://127.0.0.1:${PW_PORT}/session/${sid}/navigate" \
                    -H 'content-type: application/json' \
                    -d '{"url":"https://news.ycombinator.com"}' >/dev/null 2>&1 || true
            fi
            # Find the playwright Chromium browser process (the parent — its
            # cmdline contains user-data-dir but NOT --type=, which only the
            # zygote/renderer/gpu helpers have).
            for _ in $(seq 1 60); do
                pid=$(ps -e -o pid=,args= 2>/dev/null \
                    | awk -v p="$PW_PROFILE_FOR_PIN" '
                        index($0, "user-data-dir=" p) && !/--type=/ { print $1; exit }
                    ')
                if [ -n "$pid" ]; then
                    echo "$pid" > /tmp/pw-chrome-pid
                    break
                fi
                sleep 1
            done
            break
        fi
        sleep 1
    done
) &

# ---- SPECTRE Chromium on workspace 3 --------------------------------------
# Wait for SPECTRE Flask to answer /api/health, then launch a kiosk Chromium
# pointed at it. Same binary-detection fallback as the Hub block.
log "launching SPECTRE Chromium → workspace 3 (waiting for Flask /api/health)"
(
    for _ in $(seq 1 60); do
        if curl -fsS "http://127.0.0.1:${SPECTRE_PORT}/api/health" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    if command -v chromium >/dev/null; then C=chromium
    elif command -v chromium-browser >/dev/null; then C=chromium-browser
    elif command -v google-chrome >/dev/null; then C=google-chrome
    else
        C=$(find /root/.cache/ms-playwright -name chrome -type f 2>/dev/null | head -1)
    fi
    [ -n "$C" ] || { echo "[arcade-launch] no chromium binary found for SPECTRE"; exit 1; }
    exec "$C" \
        --user-data-dir=/tmp/spectre-profile \
        --no-first-run \
        --no-default-browser-check \
        --disable-gpu \
        --no-sandbox \
        --disable-dev-shm-usage \
        --window-name=ArcadeSpectre \
        --class=ArcadeSpectre \
        --start-maximized \
        --window-size="${DISPLAY_WIDTH},${DISPLAY_HEIGHT}" \
        --window-position=0,0 \
        --kiosk \
        "http://127.0.0.1:${SPECTRE_PORT}/?kiosk=1"
) &
SPECTRE_CHROME_PID=$!

# ---- window-to-workspace assignment watcher -------------------------------
# wmctrl -i -r WID -t N requires the window to exist. Java in particular can
# take 10+s to map its window, and Chromium spawns child windows we want to
# co-locate with their parent. So we re-run the assignment in a loop —
# idempotent: assigning a window that's already on the right desktop is a
# no-op. The loop also handles "window destroyed and recreated" (e.g. a
# Chromium splash → main window swap).
log "starting window-assignment watcher"
(
    assign_by_class() {
        local wm_class="$1" desktop="$2"
        # wmctrl -lx prints `WID DESK HOST CLASS TITLE`; match the CLASS column.
        wmctrl -lx 2>/dev/null | awk -v c="$wm_class" '$3 ~ c { print $1 }' \
            | while read -r wid; do
                wmctrl -i -r "$wid" -t "$desktop" 2>/dev/null || true
            done
    }
    assign_by_pid() {
        local target_pid="$1" desktop="$2"
        # `wmctrl -lp` prints `WID DESK PID HOST TITLE`; match PID and any
        # descendant. Also catches PIDs that exec'd into the JVM.
        wmctrl -lp 2>/dev/null | awk -v p="$target_pid" '$3 == p { print $1 }' \
            | while read -r wid; do
                wmctrl -i -r "$wid" -t "$desktop" 2>/dev/null || true
            done
    }
    # Java's window may not share PID with our subshell — match by Java's
    # "Minecraft*" window class instead.
    #
    # The three Chromiums (Hub, Playwright, SPECTRE) all run from the same
    # playwright-bundled chrome binary on the same Xvfb display, and we've
    # observed that --class=ArcadeFoo does NOT always survive on this build,
    # which used to cause the SPECTRE error window ("127.0.0.1:5050 refused"
    # whenever the spectre named volume wasn't seeded) to leak onto the
    # Playwright workspace via a catch-all rule. So we pin by PID first
    # (reliable: each Chromium's parent PID is captured at spawn time) and
    # only fall back to class-matching for windows that don't have a PID
    # association in wmctrl -lp.
    while sleep 0.5; do
        if [ -r /tmp/pw-chrome-pid ]; then
            PW_CHROME_PID=$(cat /tmp/pw-chrome-pid 2>/dev/null || echo 0)
        fi

        # PID-based pinning — authoritative.
        [ "${HUB_PID:-0}" != "0" ]            && assign_by_pid "$HUB_PID" 0            || true
        [ "${PW_CHROME_PID:-0}" != "0" ]      && assign_by_pid "$PW_CHROME_PID" 2      || true
        [ "${SPECTRE_CHROME_PID:-0}" != "0" ] && assign_by_pid "$SPECTRE_CHROME_PID" 3 || true

        # Class-based pinning — covers windows wmctrl -lp doesn't attribute to
        # the captured PIDs (e.g. transient Chromium splash windows). Java's
        # main window also has to come in this way because the JVM PID and
        # our subshell PID don't always match.
        assign_by_class "ArcadeHub" 0 || true
        assign_by_class "[Mm]inecraft" 1 || true
        assign_by_class "ArcadeSpectre" 3 || true
    done
) &
WATCHER_PID=$!

# Default workspace = 0 (Hub).
(
    sleep 4
    wmctrl -s 0 2>/dev/null || true
) &

log "all background services launched; entering wait loop"
log "  control=${CTRL_PID}  pw-fastify=${PW_PID}  spectre=${SPECTRE_PID}  hub=${HUB_PID}  mc=${MC_PID}  spectre-chrome=${SPECTRE_CHROME_PID}  watcher=${WATCHER_PID}"

# We exit (and trigger the base-image teardown) ONLY if the control server or
# the playwright fastify dies — those are required. Hub Chromium / Minecraft /
# SPECTRE / watcher dying is recoverable; we just leave the workspace blank.
on_term() {
    log "received SIGTERM, killing children"
    PIDS_TO_KILL="${CTRL_PID} ${PW_PID} ${HUB_PID} ${MC_PID} ${SPECTRE_CHROME_PID} ${WATCHER_PID}"
    [ "${SPECTRE_PID}" != "0" ] && PIDS_TO_KILL="${PIDS_TO_KILL} ${SPECTRE_PID}"
    kill ${PIDS_TO_KILL} 2>/dev/null || true
    exit 0
}
trap on_term SIGTERM SIGINT

while true; do
    if ! kill -0 "${CTRL_PID}" 2>/dev/null; then
        log "control server died; tearing down"
        exit 1
    fi
    if ! kill -0 "${PW_PID}" 2>/dev/null; then
        log "playwright fastify died; tearing down"
        exit 1
    fi
    if [ -z "${MC_DIED:-}" ] && ! kill -0 "${MC_PID}" 2>/dev/null; then
        log "Minecraft client exited; tail /tmp/mc-client.log:"
        tail -30 /tmp/mc-client.log 2>/dev/null | sed 's/^/[mc] /'
        MC_DIED=1
    fi
    if [ "${SPECTRE_PID}" != "0" ] && [ -z "${SPECTRE_DIED:-}" ] && ! kill -0 "${SPECTRE_PID}" 2>/dev/null; then
        log "SPECTRE Flask exited; tail /tmp/spectre.log:"
        tail -30 /tmp/spectre.log 2>/dev/null | sed 's/^/[spectre] /'
        SPECTRE_DIED=1
    fi
    sleep 5
done
