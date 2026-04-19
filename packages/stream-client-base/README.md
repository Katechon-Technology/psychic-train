# stream-client-base

Base Docker image for psychic-train stream-client containers. Provides:

- Xvfb virtual display on `$DISPLAY`
- openbox window manager
- FFmpeg x11grab → HLS at `/tmp/hls/stream.m3u8`
- nginx serving the HLS manifest + an embedded hls.js player on port 3000

Child images (one per plugin) add kind-specific binaries and a `/app/launch.sh`
that the base entrypoint execs after the X server is up. Example:

```dockerfile
FROM psychic-train/stream-client-base:latest
RUN apt-get update && apt-get install -y chromium-browser
COPY launch.sh /app/launch.sh
RUN chmod +x /app/launch.sh
```

`/app/launch.sh` is expected to launch whatever should render into the Xvfb display,
and to stay in the foreground (the base entrypoint monitors its PID).

## Environment variables consumed by the base

- `DISPLAY` (default `:1`)
- `DISPLAY_WIDTH` (default `1280`)
- `DISPLAY_HEIGHT` (default `720`)
- `DISPLAY_FPS` (default `30`)
- `STREAM_WARMUP_SECONDS` (default `8`) — pause after starting `/app/launch.sh` before
  starting FFmpeg, so the first frame is non-black.
