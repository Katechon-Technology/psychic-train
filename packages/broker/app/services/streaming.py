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
        except Exception as e:
            # Don't swallow — the caller's spawn_session expects an exception to
            # mark the session failed. Returning None here used to leave sessions
            # in `waiting` with stream_url=NULL forever.
            raise RuntimeError(f"stream-agent spawn unreachable: {e}") from e
        if r.status_code != 200:
            raise RuntimeError(
                f"stream-agent /spawn/stream-client returned {r.status_code}: {r.text}"
            )
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
    host_port: int | None = None,
) -> None:
    """Spawn vtuber-{kind}-{slot}. Called by start_livestream when the user
    clicks "Start VTuber". Publishes host_port:3000 so viewers can reach the
    composite HLS; pass None to keep it private (e.g. RTMP-only mode)."""
    container_name = f"vtuber-{kind}-{slot}"
    source_url = f"http://{plugin_stream_container}:3000/stream.m3u8"

    env = {
        "SESSION_ID": session_id,
        "BROKER_URL": config.BROKER_URL,
        "BROKER_ADMIN_KEY": config.BROKER_ADMIN_KEY,
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
        "YOUTUBE_STREAM_KEY": config.YOUTUBE_STREAM_KEY,
    }
    volumes = []

    if config.STREAM_AGENT_URL:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{config.STREAM_AGENT_URL}/spawn/vtuber-overlay",
                json={
                    "container_name": container_name,
                    "image": config.VTUBER_OVERLAY_IMAGE,
                    "host_port": host_port,
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
        if host_port is not None:
            cmd += ["-p", f"{host_port}:3000"]
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
) -> tuple[bool, str]:
    """Spawn vtuber overlay with a public host port. RTMP side-car is started
    only if stream keys are configured; failure there is non-fatal.
    Returns (ok, message)."""
    container_name = f"vtuber-{kind}-{slot}"
    plugin_stream_container = f"stream-client-{kind}-{slot}"
    host_port = config.VTUBER_BASE_PORT + slot

    # Spawn vtuber overlay (idempotent — docker rm -f's any stale container).
    try:
        await spawn_vtuber_overlay(
            kind=kind,
            slot=slot,
            session_id=session_id,
            narration=narration,
            plugin_stream_container=plugin_stream_container,
            host_port=host_port,
        )
    except Exception as e:
        return False, f"vtuber spawn failed: {e}"

    # RTMP is optional — attempt it but don't fail the whole call if no keys
    # are configured or the exec fails.
    await _try_start_rtmp(container_name)
    return True, "vtuber started"


async def _try_start_rtmp(container_name: str) -> None:
    """Best-effort RTMP start. Logs warnings on failure; never raises."""
    try:
        if config.STREAM_AGENT_URL:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{config.STREAM_AGENT_URL}/containers/{container_name}/rtmp/start",
                    headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                    timeout=30.0,
                )
            if r.status_code != 200:
                logging.warning(f"[streaming] rtmp start returned {r.status_code}: {r.text}")
            return
        proc = await asyncio.create_subprocess_exec(
            "docker", "exec", container_name, "/scripts/start-rtmp.sh",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await proc.communicate()
        if proc.returncode != 0:
            logging.warning(
                f"[streaming] start-rtmp.sh exited {proc.returncode}: "
                f"{(err or out).decode().strip()}"
            )
    except Exception as e:
        logging.warning(f"[streaming] rtmp start error: {e}")


async def stop_livestream(kind: str, slot: int) -> tuple[bool, str]:
    """Stop the RTMP side-car only. The vtuber container is torn down by the
    route handler (which also clears session.stream_url)."""
    container_name = f"vtuber-{kind}-{slot}"

    if config.STREAM_AGENT_URL:
        try:
            async with httpx.AsyncClient() as client:
                r = await client.post(
                    f"{config.STREAM_AGENT_URL}/containers/{container_name}/rtmp/stop",
                    headers={"X-Stream-Agent-Key": config.STREAM_AGENT_KEY},
                    timeout=30.0,
                )
            if r.status_code == 200:
                return True, r.json().get("output", "rtmp stopped")
        except Exception as e:
            logging.warning(f"[streaming] rtmp stop warn: {e}")
        return True, "rtmp stop attempted"

    proc = await asyncio.create_subprocess_exec(
        "docker", "exec", container_name, "/scripts/stop-rtmp.sh",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    return True, out.decode().strip() or "rtmp stopped"


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
