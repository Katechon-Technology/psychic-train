# plugin-data

Bring-your-own-binaries directory. Plugins that need large pre-fetched datasets
(Minecraft client jars + assets, etc.) read them from a subdirectory here.
Nothing in this tree is committed except `README.md` files; the rest is
gitignored.

## Layout

```
plugin-data/
├── README.md           (this file, tracked)
├── minecraft/          ← seeded into psychic_train_minecraft_client volume
│   ├── README.md
│   ├── versions/
│   ├── libraries/
│   └── assets/
└── …                   (future plugins drop their data here)
```

## How a plugin's data gets in here

Each plugin documents its own seeding procedure in
`plugin-data/<plugin>/README.md`. The general pattern:

1. Populate `plugin-data/<plugin>/` on the host (run a download script, copy
   from another machine, etc.).
2. Run the plugin's init service to copy the contents into a Docker named
   volume. For example, for minecraft:
   ```
   cd dev
   docker compose --profile init run --rm minecraft-client-init
   ```
3. Plugin manifests reference the named volume, mounted read-only at the
   correct path inside the stream-client / env containers at runtime.

Splitting binary data out of the build step keeps Dockerfile rebuilds fast
(image layers stay small) and decouples flaky upstream CDN downloads from the
build cycle.
