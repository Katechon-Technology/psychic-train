#!/bin/bash
# Opens an initial set of windows on the desktop so the stream isn't a black
# square while the agent boots. Layout is left/right split — top-left xterm,
# bottom-left xterm, right side reserved for the browser window the agent
# opens via the control server.
set -u
log() { echo "[seed-layout] $*"; }

: "${DISPLAY:=:1}"
: "${CTRL_PORT:=8780}"
W="${DISPLAY_WIDTH:-1600}"
H="${DISPLAY_HEIGHT:-900}"
HALF=$(( W / 2 ))
HALF_H=$(( H / 2 ))

# A status strip in the bottom-right corner. Conky is cheap to run and gives
# the stream a "live machine" feel without dominating the frame.
mkdir -p /tmp/conky
cat >/tmp/conky/.conkyrc <<'EOF'
conky.config = {
  alignment = 'bottom_right',
  background = false,
  border_width = 1,
  cpu_avg_samples = 2,
  default_color = 'white',
  default_outline_color = 'white',
  default_shade_color = 'white',
  draw_borders = false,
  draw_graph_borders = true,
  draw_outline = false,
  draw_shades = false,
  use_xft = true,
  font = 'DejaVu Sans Mono:size=10',
  gap_x = 12,
  gap_y = 12,
  minimum_height = 5,
  minimum_width = 220,
  net_avg_samples = 2,
  no_buffers = true,
  out_to_console = false,
  out_to_stderr = false,
  extra_newline = false,
  own_window = true,
  own_window_class = 'Conky',
  own_window_type = 'override',
  own_window_transparent = true,
  stippled_borders = 0,
  update_interval = 1.0,
  uppercase = false,
  use_spacer = 'none',
  show_graph_scale = false,
  show_graph_range = false
};

conky.text = [[
${color grey}cpu  $color${cpu cpu0}%   ${color grey}mem  $color${memperc}%
${color grey}up   $color$uptime
${color grey}pid  $color${running_processes}
]];
EOF
DISPLAY="${DISPLAY}" conky -c /tmp/conky/.conkyrc -d 2>/dev/null || log "conky failed (non-fatal)"

# Left column — two xterms stacked. Each one runs a tmux session named after
# the slot, so terminals/exec output is captured the same way as agent-spawned
# terminals. Initial commands are filler that keeps the screen alive.
spawn_xterm() {
    local title="$1" geom="$2" cmd="$3"
    DISPLAY="${DISPLAY}" xterm \
        -title "${title}" \
        -fa 'DejaVu Sans Mono' -fs 11 \
        -bg '#0e1116' -fg '#d8dee9' \
        -geometry "${geom}" \
        -e bash -c "${cmd}" &
    disown
}

# 80 cols x 22 rows fits nicely in 800x450 at the chosen font/size.
spawn_xterm "shell-1" "80x22+10+30" \
    "echo 'shell ready'; while true; do sleep 600; done"
spawn_xterm "shell-2" "80x22+10+480" \
    "echo 'metrics shell ready'; while true; do date; sleep 5; done"

# Open the initial browser session via the control server. The control server
# launches Playwright Chromium with --load-extension and --kiosk=0 so we get a
# normal-looking window the agent can later grab and tile.
log "asking control server for an initial browser tab"
curl -fsS -X POST "http://127.0.0.1:${CTRL_PORT}/browser/tab/new" \
    -H 'content-type: application/json' \
    -d '{"url":"about:blank"}' >/dev/null \
    || log "browser/tab/new failed (non-fatal — agent will retry)"

# Wait up to 20s for Chromium to map a window, then unmaximize and place it on
# the right half. wmctrl's -e move/resize is ignored when a window is in a
# maximized state, so we have to remove the maximized-vert/-horz flags first.
log "waiting for Chromium window"
CHROME_WID=""
for _ in $(seq 1 20); do
    CHROME_WID=$(DISPLAY="${DISPLAY}" wmctrl -lG 2>/dev/null \
        | awk '{ for (i=8; i<=NF; i++) printf "%s ", $i; print "" }' \
        | nl -ba \
        | grep -iE 'chromium|chrome' \
        | head -1 \
        | awk '{print $1}' || true)
    if [ -n "${CHROME_WID}" ]; then
        # The line number is useless; re-resolve the actual window id from wmctrl.
        CHROME_WID=$(DISPLAY="${DISPLAY}" wmctrl -lG | grep -iE 'chromium|chrome' | head -1 | awk '{print $1}')
        break
    fi
    sleep 1
done

if [ -n "${CHROME_WID}" ]; then
    log "found Chromium window ${CHROME_WID}; placing on right half"
    DISPLAY="${DISPLAY}" wmctrl -i -r "${CHROME_WID}" -b remove,maximized_vert,maximized_horz || true
    DISPLAY="${DISPLAY}" wmctrl -i -r "${CHROME_WID}" -b remove,fullscreen || true
    sleep 0.5
    DISPLAY="${DISPLAY}" wmctrl -i -r "${CHROME_WID}" -e "0,${HALF},20,${HALF},$(( H - 60 ))" || true
else
    log "no Chromium window appeared after 20s"
fi

# Raise the xterms above whatever Chromium ended up doing — openbox is a
# stacking WM so a freshly-mapped browser window will land on top by default
# and visually hide the seed terminals.
DISPLAY="${DISPLAY}" wmctrl -lG 2>/dev/null | while read -r wid _ x y w h _ rest; do
    case "${rest}" in
        *shell-1*|*shell-2*)
            DISPLAY="${DISPLAY}" xdotool windowraise "${wid}" 2>/dev/null || true
            DISPLAY="${DISPLAY}" xdotool windowfocus "${wid}" 2>/dev/null || true
            ;;
    esac
done

log "seed layout done"
