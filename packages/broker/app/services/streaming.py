"""Spawn per-session container(s) that produce the HLS viewers actually watch.

Two spawn functions:

- `spawn_stream_client` — the plugin's own stream-client container. When narration
  is enabled for the kind, this is kept **private** inside the docker network (no
  host port); when narration is off, its port is published and viewers connect
  directly.
- `spawn_vtuber_overlay` — a per-session VTuber overlay container that pulls the
  plugin's private HLS via iframe, composites the Live2D avatar, runs the narration
  sidecar, and produces the final HLS (plus optional RTMP pushes) on the host port.

Both paths support a local (dev: direct `docker run`) and remote (prod: HTTP to
`stream-agent`) implementation."""

import asyncio
import logging
from typing import Any

import httpx

from ..config import config
from . import manifest as manifest_svc


# ---------------------------------------------------------------------------
# Plugin stream-client
# ---------------------------------------------------------------------------


async def spawn_stream_client(
    kind: str,
    slot: int,
    manifest: Any,
    ctx: dict[str, str],
    *,
    publish_host_port: bool = True,
    extra_ports: list[dict] | None = None,
) -> str | None:
    m_stream = manifest.stream_client
    env = manifest_svc.interpolate_env(m_stream.env, ctx)
    env.setdefault("DISPLAY_WIDTH", str(m_stream.display_width))
    env.setdefault("DISPLAY_HEIGHT", str(m_stream.display_height))
    env.setdefault("DISPLAY_FPS", str(m_stream.display_fps))

    container_name = f"stream-client-{kind}-{slot}"
    host_port = config.STREAM_BASE_PORT + slot if publish_host_port else None

    volumes = m_stream.volumes or []

    if config.STREAM_AGENT_URL:
        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{config.STREAM_AGENT_URL}/spawn/stream-client",
                    json={
                        "container_name": container_name,
                        "image": m_stream.image,
                        "host_port": host_port,
                        "extra_ports": extra_ports or [],
                        "env": env,
                        "network": config.DOCKER_NETWORK,
                        "volumes": volumes,
                    },
                    headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                    timeout=180.0,
                )
            if r.status_code != 200:
                logging.error(f"[streaming] stream-agent returned {r.status_code}: {r.text}")
                return None
        except Exception as e:
            logging.error(f"[streaming] stream-agent spawn failed: {e}")
            return None
    else:
        await _stop_container(container_name)
        cmd = ["docker", "run", "-d", "--name", container_name]
        if config.DOCKER_NETWORK:
            cmd += ["--network", config.DOCKER_NETWORK]
        for k, v in env.items():
            cmd += ["-e", f"{k}={v}"]
        for vol in volumes:
            ro = ":ro" if vol.get("readonly") else ""
            cmd += ["-v", f"{vol['name']}:{vol['mount']}{ro}"]
        if host_port is not None:
            cmd += ["-p", f"{host_port}:3000"]
        cmd += [m_stream.image]

        logging.info(
            f"[streaming] docker run {container_name} "
            f"(image={m_stream.image}, publish={publish_host_port}, vols={len(volumes)})"
        )
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            logging.error(f"[streaming] docker run failed: {(err or out).decode().strip()}")
            return None

    await _wait_for_stream(container_name, timeout=120)
    if host_port is None:
        return None  # private; caller uses vtuber's URL instead
    return config.stream_url_for_slot(slot, kind)


async def stop_stream_client(kind: str, slot: int) -> None:
    container_name = f"stream-client-{kind}-{slot}"
    if config.STREAM_AGENT_URL:
        try:
            async with httpx.AsyncClient() as client:
                await client.delete(
                    f"{config.STREAM_AGENT_URL}/containers/{container_name}",
                    headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                    timeout=30.0,
                )
        except Exception as e:
            logging.warning(f"[streaming] stream-agent DELETE failed: {e}")
        return
    await _stop_container(container_name)


# ---------------------------------------------------------------------------
# VTuber overlay
# ---------------------------------------------------------------------------


async def spawn_vtuber_overlay(
    *,
    kind: str,
    slot: int,
    session_id: str,
    narration: Any,
    plugin_stream_container: str,
    log_volume: str,
) -> None:
    """Spawn vtuber-{kind}-{slot}. Called by start_livestream (no longer at
    session spawn time) so we only pay the overlay cost while the user is
    actively broadcasting. The container pulls the plugin HLS via iframe,
    composites the Live2D avatar + narration, and exposes its own HLS on :3000
    internally — start-rtmp.sh inside the container then fans that out to
    Twitch/Kick. No host port published; nothing outside the docker network
    needs to reach it."""
    container_name = f"vtuber-{kind}-{slot}"
    source_url = f"http://{plugin_stream_container}:3000/stream.m3u8"

    env = {
        "SESSION_ID": session_id,
        "SOURCE_STREAM_URL": source_url,
        "CHARACTER_NAME": narration.character_name,
        "LIVE2D_MODEL": narration.live2d_model,
        "VOICE_ID": narration.voice_id,
        "PERSONA_PROMPT": narration.persona_prompt or narration.system_prompt,
        "NARRATION_SYSTEM_PROMPT": narration.system_prompt,
        "NARRATION_MOOD_HINTS": narration.mood_hints,
        "NARRATION_MODEL": config.NARRATION_MODEL,
        "ANTHROPIC_API_KEY": config.ANTHROPIC_API_KEY,
        "ELEVENLABS_API_KEY": config.ELEVENLABS_API_KEY,
        "TWITCH_STREAM_KEY": config.TWITCH_STREAM_KEY,
        "KICK_STREAM_KEY": config.KICK_STREAM_KEY,
    }
    volumes = [{"name": log_volume, "mount": "/var/log/session", "readonly": True}]

    if config.STREAM_AGENT_URL:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{config.STREAM_AGENT_URL}/volumes/{log_volume}",
                headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                timeout=30.0,
            )
            r = await client.post(
                f"{config.STREAM_AGENT_URL}/spawn/vtuber-overlay",
                json={
                    "container_name": container_name,
                    "image": config.VTUBER_OVERLAY_IMAGE,
                    "host_port": None,
                    "env": env,
                    "network": config.DOCKER_NETWORK,
                    "volumes": volumes,
                },
                headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                timeout=400.0,
            )
        if r.status_code != 200:
            raise RuntimeError(f"vtuber spawn returned {r.status_code}: {r.text}")
    else:
        await _stop_container(container_name)
        cmd = ["docker", "run", "-d", "--name", container_name]
        if config.DOCKER_NETWORK:
            cmd += ["--network", config.DOCKER_NETWORK]
        for k, v in env.items():
            cmd += ["-e", f"{k}={v}"]
        for vol in volumes:
            ro = ":ro" if vol.get("readonly") else ""
            cmd += ["-v", f"{vol['name']}:{vol['mount']}{ro}"]
        cmd += [config.VTUBER_OVERLAY_IMAGE]

        logging.info(f"[streaming] docker run {container_name} (vtuber; source={source_url})")
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(
                f"docker run {container_name} failed: {(err or out).decode().strip()}"
            )

    # Blocks until port 3000 (nginx + HLS manifest) is up, or raises with
    # docker-logs tail — same pattern as _wait_env_ready in environment.py.
    await _wait_for_stream(container_name, timeout=240)


async def stop_vtuber_overlay(kind: str, slot: int) -> None:
    container_name = f"vtuber-{kind}-{slot}"
    if config.STREAM_AGENT_URL:
        try:
            async with httpx.AsyncClient() as client:
                await client.delete(
                    f"{config.STREAM_AGENT_URL}/containers/{container_name}",
                    headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                    timeout=30.0,
                )
        except Exception as e:
            logging.warning(f"[streaming] vtuber DELETE failed: {e}")
        return
    await _stop_container(container_name)


# ---------------------------------------------------------------------------
# Livestream toggle — claudetorio-style: spawn the vtuber overlay container
# only when the user clicks Start Livestream (so the avatar + narration +
# RTMP side-car only burn resources when actively broadcasting). The plugin
# stream-client stays up the whole session for the frontend preview.
# ---------------------------------------------------------------------------


async def start_livestream(
    kind: str,
    slot: int,
    session_id: str,
    narration: Any,
    log_volume: str,
) -> tuple[bool, str]:
    """Spawn vtuber overlay → wait for its HLS → docker-exec /scripts/start-rtmp.sh.
    Returns (ok, message)."""
    container_name = f"vtuber-{kind}-{slot}"
    plugin_stream_container = f"stream-client-{kind}-{slot}"

    # 1. Make sure the log volume exists (might not yet if the worker never
    # ran). Harmless if already present.
    await _ensure_volume_local(log_volume)

    # 2. Spawn vtuber (idempotent — spawn_vtuber_overlay `docker rm -f`'s any
    # stale container with the same name first).
    try:
        await spawn_vtuber_overlay(
            kind=kind,
            slot=slot,
            session_id=session_id,
            narration=narration,
            plugin_stream_container=plugin_stream_container,
            log_volume=log_volume,
        )
    except Exception as e:
        return False, f"vtuber spawn failed: {e}"

    # 3. Tell the vtuber to start its RTMP side-car.
    if config.STREAM_AGENT_URL:
        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{config.STREAM_AGENT_URL}/containers/{container_name}/rtmp/start",
                    headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                    timeout=30.0,
                )
            if r.status_code != 200:
                return False, f"{r.status_code}: {r.text}"
            return True, r.json().get("output", "ok")
        except Exception as e:
            return False, str(e)

    proc = await asyncio.create_subprocess_exec(
        "docker", "exec", container_name, "/scripts/start-rtmp.sh",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        return False, (err or out).decode().strip() or "start-rtmp.sh failed"
    return True, out.decode().strip()


async def stop_livestream(kind: str, slot: int) -> tuple[bool, str]:
    """Stop the RTMP side-car, then tear down the vtuber container itself.
    Preview stays live because the plugin stream-client is untouched."""
    container_name = f"vtuber-{kind}-{slot}"
    messages: list[str] = []

    # 1. Best-effort stop of the RTMP side-car. If the container is already
    # gone this is a no-op.
    if config.STREAM_AGENT_URL:
        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{config.STREAM_AGENT_URL}/containers/{container_name}/rtmp/stop",
                    headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                    timeout=30.0,
                )
            if r.status_code == 200:
                messages.append(r.json().get("output", "rtmp stopped"))
        except Exception as e:
            messages.append(f"rtmp stop warn: {e}")
    else:
        proc = await asyncio.create_subprocess_exec(
            "docker", "exec", container_name, "/scripts/stop-rtmp.sh",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        if proc.returncode == 0:
            messages.append(out.decode().strip())

    # 2. Tear down the vtuber container so we reclaim CPU/RAM between broadcasts.
    await stop_vtuber_overlay(kind, slot)
    messages.append("vtuber container removed")
    return True, "; ".join(messages)


async def _ensure_volume_local(name: str) -> None:
    """Create a named Docker volume if it doesn't exist. Local path only;
    remote path (stream-agent /volumes/{name}) is handled inside
    spawn_vtuber_overlay."""
    if config.STREAM_AGENT_URL:
        return
    proc = await asyncio.create_subprocess_exec(
        "docker", "volume", "create", name,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _wait_for_stream(container_name: str, timeout: int = 120) -> None:
    """Block until the container's port 3000 accepts TCP, or raise with a log
    tail. Matches environment._wait_env_ready's fail-fast pattern so stream /
    vtuber startup failures surface as a clear session.error instead of a
    silent 'waiting' session that never actually works."""
    if config.STREAM_AGENT_URL:
        # Remote path: stream-agent already waited for port + HLS sentinel
        # before returning 200 to the spawn call, so we trust that here.
        return

    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        state = await _container_state(container_name)
        if state in ("exited", "dead"):
            tail = await _docker_logs_tail(container_name, 60)
            raise RuntimeError(
                f"{container_name} exited before port 3000 opened (state={state}).\n"
                f"--- last 60 lines of docker logs {container_name} ---\n{tail.strip()}"
            )
        try:
            reader, writer = await asyncio.open_connection(container_name, 3000)
            writer.close()
            await writer.wait_closed()
            return
        except Exception:
            await asyncio.sleep(2)

    tail = await _docker_logs_tail(container_name, 60)
    raise RuntimeError(
        f"{container_name} port 3000 not reachable after {timeout}s.\n"
        f"--- last 60 lines of docker logs {container_name} ---\n{tail.strip()}"
    )


async def _container_state(name: str) -> str | None:
    proc = await asyncio.create_subprocess_exec(
        "docker", "inspect", "-f", "{{.State.Status}}", name,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return None
    return out.decode().strip() or None


async def _docker_logs_tail(name: str, n: int = 60) -> str:
    proc = await asyncio.create_subprocess_exec(
        "docker", "logs", "--tail", str(n), name,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    return out.decode(errors="replace")


async def _stop_container(name: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "docker", "rm", "-f", name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
