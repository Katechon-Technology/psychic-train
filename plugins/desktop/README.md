# desktop plugin

Full Linux desktop where Claude burns through a research-and-act task at high
speed. Topology is `combined`: the stream-client image *is* the environment.

## What's inside

- **stream-client** (`psychic-train/desktop-stream-client`)
  - Inherits `stream-client-base` (Xvfb on `:1`, openbox, ffmpeg → HLS, nginx :3000).
  - A Fastify **control server** on `:8780` exposes mouse/keyboard, windows,
    terminals, browser tabs, and a sandboxed `/workspace` filesystem.
  - Preinstalled tooling: `xdotool`, `wmctrl`, `xclip`, `imagemagick`, `feh`,
    `tmux`, `xterm`, `conky`; Python 3 with `numpy`, `pandas`, `matplotlib`,
    `requests`, `beautifulsoup4`, `pyautogui`; Node 20 + Playwright Chromium
    with Consent-O-Matic + uBlock Origin Lite.
  - `seed_layout.sh` opens two xterms on the left, the Chromium window on the
    right, and a conky status strip in the corner so the stream is alive from
    the first frame.

- **agent** (`psychic-train/desktop-agent`)
  - Director Claude loop (model from `MODEL` env, default Sonnet 4.5).
  - Tool surface: `desktop_*` (mouse/keyboard/windows/terminals/browser/fs)
    plus `spawn_worker` / `list_workers` / `collect_worker` / `think_aloud`.
  - Workers are in-process Claude threads with a slimmer `desktop_*` toolset
    plus `final_report`. They run concurrently as `Promise`s; the director
    polls or blocks via `collect_worker`.
  - Every tool call posts a `kind: "tool"` event to the broker so the existing
    vtuber-overlay narrator can react without modification.

## Building

From `psychic-train/dev/`:

```bash
docker compose --profile build build stream-client-base
docker compose --profile build build desktop-stream-client desktop-agent
```

(Or `docker compose --profile build build` to build everything.)

## Running a session

```bash
docker compose up -d postgres redis broker frontend
curl http://localhost:8080/api/kinds        # confirm desktop is registered
curl -X POST http://localhost:8080/api/sessions \
  -H "Authorization: Bearer ${BROKER_ADMIN_KEY:-dev}" \
  -H "Content-Type: application/json" \
  -d '{"kind":"desktop"}'
# -> { stream_url: "http://localhost:30??/stream.m3u8", id: "desktop-…" }
```

Open the returned `stream_url` in a browser. Once you're happy with the seed
layout, click **Start Worker** in the frontend (or hit
`POST /api/sessions/<id>/worker/start`) to launch the agent container.

## Smoke-testing the control API in isolation

```bash
docker run --rm -p 8780:8780 -p 3000:3000 \
  psychic-train/desktop-stream-client:latest
curl -X POST localhost:8780/screenshot | jq -r .png_b64 | base64 -d > /tmp/d.png
curl -X POST localhost:8780/terminal/spawn \
  -H 'content-type: application/json' \
  -d '{"cmd":"python3 -c \"print(2+2)\"","title":"smoke"}'
curl -X POST localhost:8780/window/list
```

## Customizing the task

The director's brief comes from `agent.env.TASK` in `manifest.yaml`. Default
is a Polymarket research-and-bet brief; swap it for any short research-and-act
task. (The agent walks through the bet UI but stops before wallet connect —
no real money.)

## Out of scope (v1)

- Real wallet integration on Polymarket.
- Per-session browser profile isolation (the named profile is shared per slot).
- CPU/memory limits on spawned containers (broker doesn't enforce these yet).
- Cross-container worker fanout (workers are in-process Claude threads).
