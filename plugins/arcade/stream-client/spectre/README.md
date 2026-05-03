# SPECTRE — vendored source

Vendored copy of `katechon-app/applications/SPECTRE/`, the Flask-based Global
Intelligence & Threat Monitor that runs as workspace 3 inside the arcade
stream-client container.

The contents of this directory are gitignored — only this README is committed,
so the path exists for the Docker COPY in
`plugins/arcade/stream-client/Dockerfile`.

## Seeding / refreshing the vendored copy

```bash
./plugins/arcade/stream-client/seed-spectre.sh
```

The script rsyncs from `../../katechon-app/applications/SPECTRE/` (relative to
the psychic-train repo root) into this directory. Re-run it whenever SPECTRE
upstream changes. Override the source location with `SPECTRE_SRC=/path/to/src`
if your sibling-repo layout is different.

After seeding, rebuild the stream-client image:

```bash
cd dev && docker compose --profile build build arcade-stream-client
```
