# playwright-browser plugin

A self-contained psychic-train kind that drives a headed Chromium and streams
the captured display. The full Fastify server source lives in this plugin tree
at `stream-client/pw-browser/`; there is **no external dependency on a sibling
playwright-browser repo**.

**Topology: combined** — unlike Factorio/Minecraft where the environment and the
stream-client are separate containers, here the thing being driven (Chromium rendered
under Xvfb) is also the thing being captured. So the stream-client container bundles
the playwright-browser Fastify server and launches it as `/app/launch.sh`. The agent
container runs separately and HTTP-calls the API at `$ENV_HOST:$API_PORT/session/...`.

## Building

The stream-client Dockerfile copies the bundled Fastify server source from
`stream-client/pw-browser/` (TypeScript, run via `tsx`). Run `docker compose
build` from `dev/` — it will build the deps automatically.

## Agent

The agent is a deterministic doomscroll loop (no Claude in the agent itself).
It rotates between ~14 no-paywall news sites — tech aggregators (Hacker News,
Lobsters, Techmeme), political aggregators (Memeorandum, Drudge), tabloids
(Daily Mail, NY Post, The Sun), majors (BBC, Guardian, AP, Al Jazeera),
conflict trackers (liveuamap), and Reddit's r/worldnews — spending ~5 minutes
on each: scrolling on a jittered cadence and occasionally clicking a
headline-shaped link, dwelling on the article, and returning to the feed. It
runs until the session TTL kills the container. See the `SITES` array in
`agent/main.ts` for the exact list.

Narration is generated separately by the vtuber-overlay sidecar, which polls
the broker's event log; the agent emits `kind:"tool"` events with
`name` ∈ `{navigate, scroll, click}` so the existing narrator pipeline picks
them up. See `agent/main.ts` and the bundled HTTP API at
`stream-client/pw-browser/src/server.ts` for the routes called.
