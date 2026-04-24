# vtuber-overlay

Per-session container that takes a plugin's local HLS stream, overlays a Live2D
avatar and Claude-voiced narration, and re-outputs as HLS (plus optional RTMP).

Derived from `../../../claudetorio/packages/vtuber-stream-client/`; most of the
pipeline is unchanged (same Open-LLM-VTuber commit, same patches, same Live2D model).
Key differences:

- Sources the HLS to overlay from `$SOURCE_STREAM_URL` (plugin's docker-internal URL).
- RTMP output is **additive** — `YOUTUBE_STREAM_KEY` is optional. HLS is always
  produced so viewers get a stream regardless.
- Narration reads from a shared-volume JSONL log at
  `/var/log/session/agent.jsonl` instead of polling the broker.
- `CHARACTER_NAME`, `LIVE2D_MODEL`, `VOICE_ID`, `PERSONA_PROMPT`,
  `NARRATION_SYSTEM_PROMPT`, `NARRATION_MOOD_HINTS` come from the plugin's manifest
  via envsubst.

## Env vars

| Variable | Required? | Default | Purpose |
|----------|-----------|---------|---------|
| `SOURCE_STREAM_URL` | yes | — | Plugin HLS m3u8 URL (e.g. `http://stream-client-factorio-0:3000/stream.m3u8`) |
| `ANTHROPIC_API_KEY` | for narration | — | Without it, avatar + narrator are skipped; plain HLS passthrough still works |
| `ELEVENLABS_API_KEY` | for voice | — | Without it, avatar lip-syncs only (Open-LLM-VTuber falls back to default TTS if configured) |
| `CHARACTER_NAME` | no | `Claude` | Displayed character name |
| `LIVE2D_MODEL` | no | `mao_pro` | Live2D model (currently only mao_pro vendored) |
| `VOICE_ID` | no | `jqcCZkN6Knx8BJ5TBdYR` | ElevenLabs voice id |
| `PERSONA_PROMPT` | no | generic | Fed into Open-LLM-VTuber conf.yaml |
| `NARRATION_SYSTEM_PROMPT` | no | generic | The narrator's Claude system prompt |
| `NARRATION_MOOD_HINTS` | no | `` | Extra mood-trigger guidance for the narrator |
| `NARRATION_MODEL` | no | `claude-haiku-4-5-20251001` | Model for narration messages |
| `YOUTUBE_STREAM_KEY` | no | — | If set, FFmpeg also pushes RTMP to YouTube Live (`rtmp://a.rtmp.youtube.com/live2/${key}`) |
| `DISPLAY_WIDTH` / `DISPLAY_HEIGHT` / `DISPLAY_FPS` | no | 1920/1080/30 | Output resolution/framerate |

## Volume mounts

- `session-logs-{session_id}:/var/log/session:ro` — the JSONL log the agent writes,
  tailed by the narrator sidecar.

## Output

- **HLS**: `http://<host>:3000/stream.m3u8` via nginx (served by the inherited
  `stream-client-base` config).
- **RTMP**: one FLV output per configured stream key.
