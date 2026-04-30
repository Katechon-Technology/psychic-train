"""Session lifecycle orchestrator. Claudetorio-style:

  POST /api/sessions         → spawn env + stream-client + vtuber; stop at
                               `waiting` (preview is watchable, no agent yet).
  POST /sessions/{id}/worker/start
                             → spawn agent container with the user-supplied
                               Anthropic key + model; status is then
                               worker_status=running, session.status stays
                               `waiting`.
  POST /sessions/{id}/worker/stop
                             → docker rm -f the agent; env + stream stay up.
  DELETE /api/sessions/{id}  → full teardown.

The env-readiness watcher (`_wait_env_ready`) tails `docker logs` if the env
container exits before its port opens, so failures like a missing Minecraft
Fabric JAR surface in seconds instead of a 240 s silent timeout.
"""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from ..config import config
from ..db import async_session_factory
from ..models import Session
from ..state import AppState
from . import manifest as manifest_svc
from . import slots as slots_svc
from . import streaming as streaming_svc


def _env_container_name(kind: str, slot: int) -> str:
    return f"env-{kind}-{slot}"


def _agent_container_name(session_id: str, agent_kind: str | None = None) -> str:
    """Single-agent plugins use `agent-{session_id}`; multi-agent plugins use
    `agent-{session_id}-{agent_kind}` (one container per logical agent in the
    manifest's `agents:` map)."""
    if agent_kind is None:
        return f"agent-{session_id}"
    return f"agent-{session_id}-{agent_kind}"


def _stream_container_name(kind: str, slot: int) -> str:
    return f"stream-client-{kind}-{slot}"


def _vtuber_container_name(kind: str, slot: int) -> str:
    return f"vtuber-{kind}-{slot}"


def _log_volume_name(session_id: str) -> str:
    return f"session-logs-{session_id}"


# ---------------------------------------------------------------------------
# spawn_session: env + stream-client + vtuber, stop at waiting
# ---------------------------------------------------------------------------


async def spawn_session(session_id: str, kind: str, slot: int, app_state: AppState) -> None:
    """Background task kicked off by POST /api/sessions.

    Starts the environment, stream-client, and (when narration is enabled) the
    vtuber overlay. Does NOT start the agent — the user clicks Start Worker
    separately to do that. Leaves the session in status=`waiting`."""
    m = app_state.kinds[kind]
    narration_on = m.narration is not None

    try:
        await _set_status(session_id, "starting")

        env_host = (
            _env_container_name(kind, slot)
            if m.topology == "separate"
            else _stream_container_name(kind, slot)
        )
        ctx = manifest_svc.build_context(
            slot=slot,
            session_id=session_id,
            kind=kind,
            ports=m.ports,
            env_host=env_host,
            combined=(m.topology == "combined"),
        )

        # Note: session-logs-{id} Docker volume is created lazily — only when
        # the user starts a worker (which writes) or starts a livestream
        # (which reads). Both paths call _docker_volume_create / _ensure_volume_local
        # idempotently.

        # 1. Environment container.
        if m.topology == "separate" and m.environment:
            await _docker_run(
                name=_env_container_name(kind, slot),
                image=m.environment.image,
                env=manifest_svc.interpolate_env(m.environment.env, ctx),
                volumes=m.environment.volumes,
                ports=[(p.protocol, p.base + slot, p.base) for p in m.ports],
            )
            if m.environment.healthcheck:
                await _wait_env_ready(
                    m.environment.healthcheck, ctx, _env_container_name(kind, slot)
                )

        # 2. Plugin stream-client — always published on STREAM_BASE_PORT + slot.
        # The vtuber overlay (when started later) gets VTUBER_BASE_PORT + slot
        # and session.stream_url is updated to point at it; stopping the vtuber
        # reverts stream_url back here.
        #
        # For combined topology in two-server prod (STREAM_AGENT_URL set), the
        # stream-client runs on the stream server while the agent runs on the
        # game server. Publish the plugin's API ports so the agent can reach
        # the environment over the stream server's public host.
        extra_ports: list[dict] = []
        if m.topology == "combined" and config.STREAM_AGENT_URL:
            extra_ports = [
                {"host": p.base + slot, "container": p.base}
                for p in m.ports
            ]
            ctx["env_host"] = config.STREAM_PUBLIC_HOST
            for p in m.ports:
                ctx[f"{p.name}_port"] = str(p.base + slot)
                ctx[f"{p.name}_internal"] = str(p.base + slot)
        elif m.topology == "separate" and config.STREAM_AGENT_URL and config.GAME_SERVER_PUBLIC_HOST:
            # Stream-client runs on stream server; env container runs on game server.
            # Override env_host and port vars so the stream-client uses the public host.
            ctx["env_host"] = config.GAME_SERVER_PUBLIC_HOST
            for p in m.ports:
                ctx[f"{p.name}_port"] = str(p.base + slot)
                ctx[f"{p.name}_internal"] = str(p.base + slot)

        plugin_stream_url = await streaming_svc.spawn_stream_client(
            kind, slot, m, ctx, publish_host_port=True, extra_ports=extra_ports,
        )

        # 3. Ready for viewers. Status=waiting; no worker, no overlay.
        async with async_session_factory() as db:
            sess = await db.get(Session, session_id)
            if sess:
                sess.status = "waiting"
                sess.stream_url = plugin_stream_url
                sess.started_at = datetime.now(timezone.utc)
                await db.commit()

    except Exception as e:
        logging.exception(f"spawn_session {session_id} failed")
        async with async_session_factory() as db:
            sess = await db.get(Session, session_id)
            if sess:
                sess.status = "failed"
                sess.error = str(e)
                sess.ended_at = datetime.now(timezone.utc)
                await db.commit()
        # Best-effort cleanup.
        await _docker_stop(_agent_container_name(session_id))
        await streaming_svc.stop_stream_client(kind, slot)
        if m.topology == "separate":
            await _docker_stop(_env_container_name(kind, slot))
        await slots_svc.release_slot(kind, slot, app_state.redis)


# ---------------------------------------------------------------------------
# start_worker / stop_worker
# ---------------------------------------------------------------------------


async def start_worker(
    session_id: str,
    kind: str,
    slot: int,
    api_key: str,
    model: str | None,
    app_state: AppState,
) -> None:
    """Background task kicked off by POST /sessions/{id}/worker/start."""
    m = app_state.kinds[kind]
    narration_on = m.narration is not None
    if m.agent is None:
        async with async_session_factory() as db:
            sess = await db.get(Session, session_id)
            if sess:
                sess.worker_status = "error"
                sess.state = {
                    **(sess.state or {}),
                    "worker_error": (
                        f"kind {kind} has no single `agent:`; use "
                        f"/agents/<kind>/start instead"
                    ),
                }
                await db.commit()
        return

    try:
        env_host = (
            _env_container_name(kind, slot)
            if m.topology == "separate"
            else (
                config.STREAM_PUBLIC_HOST
                if config.STREAM_AGENT_URL
                else _stream_container_name(kind, slot)
            )
        )
        ctx = manifest_svc.build_context(
            slot=slot,
            session_id=session_id,
            kind=kind,
            ports=m.ports,
            env_host=env_host,
            combined=(m.topology == "combined"),
        )
        if m.topology == "combined" and config.STREAM_AGENT_URL:
            for p in m.ports:
                ctx[f"{p.name}_port"] = str(p.base + slot)
        # Override the defaults with what the user entered in the modal.
        ctx["anthropic_api_key"] = api_key
        if model:
            ctx["model"] = model

        await _docker_run(
            name=_agent_container_name(session_id),
            image=m.agent.image,
            env=manifest_svc.interpolate_env(m.agent.env, ctx),
            volumes=[],
            remove=True,
        )

        async with async_session_factory() as db:
            sess = await db.get(Session, session_id)
            if sess:
                sess.worker_status = "running"
                await db.commit()

        asyncio.create_task(_monitor_worker(session_id, app_state))

    except Exception as e:
        logging.exception(f"start_worker {session_id} failed")
        async with async_session_factory() as db:
            sess = await db.get(Session, session_id)
            if sess:
                sess.worker_status = "error"
                sess.state = {**(sess.state or {}), "worker_error": str(e)}
                await db.commit()
        await _docker_stop(_agent_container_name(session_id))


async def stop_worker(session_id: str, app_state: AppState) -> None:
    async with async_session_factory() as db:
        sess = await db.get(Session, session_id)
        if sess:
            sess.worker_status = "stopping"
            await db.commit()
    await _docker_stop(_agent_container_name(session_id))
    async with async_session_factory() as db:
        sess = await db.get(Session, session_id)
        if sess:
            sess.worker_status = "off"
            await db.commit()


# ---------------------------------------------------------------------------
# Per-agent lifecycle (multi-agent plugins like `arcade`)
# ---------------------------------------------------------------------------
#
# Single-agent plugins use start_worker/stop_worker above; the worker_status
# column is the source of truth.
#
# Multi-agent plugins declare `agents:` map in their manifest. Each logical
# agent runs in its own `agent-{session_id}-{kind}` container and has an entry
# in `session.state["agents"][kind] = {status, container, exit_code?}`.
# Status values: off | starting | running | paused | stopping | error.
# The container is created without --rm so docker pause/unpause work; on stop
# we explicitly `docker rm -f`.


async def _set_agent_state(session_id: str, agent_kind: str, **fields: Any) -> None:
    async with async_session_factory() as db:
        sess = await db.get(Session, session_id)
        if not sess:
            return
        state = dict(sess.state or {})
        agents = dict(state.get("agents") or {})
        entry = dict(agents.get(agent_kind) or {})
        entry.update(fields)
        agents[agent_kind] = entry
        state["agents"] = agents
        sess.state = state
        await db.commit()


async def start_agent(
    session_id: str,
    agent_kind: str,
    api_key: str,
    model: str | None,
    task: str | None,
    app_state: AppState,
) -> None:
    """Spawn (or resume) a per-agent container for a multi-agent plugin.

    If the container already exists and is paused, unpause it. If it exists and
    is running, no-op. Otherwise, fresh `docker run` (without --rm so we can
    pause it later)."""
    async with async_session_factory() as db:
        sess = await db.get(Session, session_id)
        if not sess or sess.slot is None:
            raise RuntimeError(f"session {session_id} has no slot")
        kind = sess.kind
        slot = sess.slot

    m = app_state.kinds[kind]
    if not m.agents or agent_kind not in m.agents:
        raise RuntimeError(f"kind {kind} has no agent named {agent_kind!r}")
    spec = m.agents[agent_kind]
    name = _agent_container_name(session_id, agent_kind)

    state = await _container_state(name)
    if state == "paused":
        # If a task was supplied we always want a fresh container with the new
        # TASK_HINT, so skip unpause and fall through to docker_stop + run.
        if not task:
            logging.info(f"[agent] unpausing {name}")
            proc = await asyncio.create_subprocess_exec(
                "docker", "unpause", name,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
            )
            _, err = await proc.communicate()
            if proc.returncode == 0:
                await _set_agent_state(session_id, agent_kind, status="running")
                return
            logging.warning(
                f"[agent] unpause {name} failed ({(err or b'').decode().strip()}); restarting fresh"
            )
        await _docker_stop(name)
    elif state == "running":
        # No task means "make sure it's running" — keep the no-op fast path.
        # With a task, we restart so the env var actually reaches the agent.
        if not task:
            return
        logging.info(f"[agent] task supplied; restarting running {name} with new TASK_HINT")
        await _docker_stop(name)
    elif state in ("created", "exited", "dead"):
        await _docker_stop(name)

    env_host = (
        _env_container_name(kind, slot)
        if m.topology == "separate"
        else (
            config.STREAM_PUBLIC_HOST
            if config.STREAM_AGENT_URL
            else _stream_container_name(kind, slot)
        )
    )
    ctx = manifest_svc.build_context(
        slot=slot,
        session_id=session_id,
        kind=kind,
        ports=m.ports,
        env_host=env_host,
        combined=(m.topology == "combined"),
    )
    ctx["anthropic_api_key"] = api_key
    if model:
        ctx["model"] = model
    # Always set so manifests using `{task_hint}` interpolate to "" instead of
    # leaking the literal placeholder when no task was supplied.
    ctx["task_hint"] = task or ""

    env = manifest_svc.interpolate_env(spec.env, ctx)
    if task and "TASK_HINT" not in env:
        env["TASK_HINT"] = task

    await _set_agent_state(session_id, agent_kind, status="starting", container=name)
    try:
        await _docker_run(
            name=name,
            image=spec.image,
            env=env,
            volumes=spec.volumes or [],
            remove=False,  # keep around so docker pause/unpause work
        )
        await _set_agent_state(session_id, agent_kind, status="running")
        asyncio.create_task(_monitor_agent(session_id, agent_kind, app_state))
    except Exception as e:
        logging.exception(f"start_agent {name} failed")
        await _set_agent_state(session_id, agent_kind, status="error", error=str(e))
        await _docker_stop(name)


async def stop_agent(session_id: str, agent_kind: str) -> None:
    name = _agent_container_name(session_id, agent_kind)
    await _set_agent_state(session_id, agent_kind, status="stopping")
    await _docker_stop(name)
    await _set_agent_state(session_id, agent_kind, status="off")


async def pause_agent(session_id: str, agent_kind: str) -> None:
    name = _agent_container_name(session_id, agent_kind)
    state = await _container_state(name)
    if state != "running":
        return
    proc = await asyncio.create_subprocess_exec(
        "docker", "pause", name,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        msg = (err or b"").decode().strip()
        logging.warning(f"[agent] pause {name} failed: {msg}")
        return
    await _set_agent_state(session_id, agent_kind, status="paused")


async def resume_agent(
    session_id: str,
    agent_kind: str,
    api_key: str,
    model: str | None,
    app_state: AppState,
) -> None:
    """Unpause; if that fails, fall through to a fresh spawn via start_agent."""
    name = _agent_container_name(session_id, agent_kind)
    state = await _container_state(name)
    if state == "paused":
        proc = await asyncio.create_subprocess_exec(
            "docker", "unpause", name,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        if proc.returncode == 0:
            await _set_agent_state(session_id, agent_kind, status="running")
            return
    # Either not paused (already running, or exited), or unpause failed.
    await start_agent(session_id, agent_kind, api_key, model, None, app_state)


async def _monitor_agent(session_id: str, agent_kind: str, app_state: AppState) -> None:
    """Flip per-agent status when the container exits. Pauses don't trip this —
    only an actual `exited`/`dead` state does."""
    name = _agent_container_name(session_id, agent_kind)
    while True:
        state = await _container_state(name)
        if state in (None, "exited", "dead"):
            break
        await asyncio.sleep(5)

    exit_code = 0
    proc = await asyncio.create_subprocess_exec(
        "docker", "inspect", "-f", "{{.State.ExitCode}}", name,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    try:
        exit_code = int(out.decode().strip() or "0")
    except ValueError:
        pass

    fields: dict[str, Any] = {
        "status": "error" if exit_code != 0 else "off",
        "exit_code": exit_code,
    }
    await _set_agent_state(session_id, agent_kind, **fields)


async def reap_session_agents(session_id: str) -> None:
    """Force-remove every agent-{session_id}-* container. Called from teardown."""
    proc = await asyncio.create_subprocess_exec(
        "docker", "ps", "-aq", "--filter", f"name=^agent-{session_id}-",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    ids = [i for i in out.decode().split() if i]
    if not ids:
        return
    proc = await asyncio.create_subprocess_exec(
        "docker", "rm", "-f", *ids,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()


async def workspace_switch(
    session_id: str,
    workspace: int,
    app_state: AppState,
) -> None:
    """Tell the stream-client to switch its X11 workspace. Used by multi-agent
    plugins like `arcade` whose stream-client runs an openbox WM with multiple
    desktops. Records `state["current_workspace"]` for the frontend."""
    async with async_session_factory() as db:
        sess = await db.get(Session, session_id)
        if not sess or sess.slot is None:
            raise RuntimeError(f"session {session_id} has no slot")
        kind = sess.kind
        slot = sess.slot

    container = _stream_container_name(kind, slot)
    proc = await asyncio.create_subprocess_exec(
        "docker", "exec", container, "wmctrl", "-s", str(workspace),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        msg = (err or b"").decode().strip()
        raise RuntimeError(f"workspace switch failed: {msg}")

    async with async_session_factory() as db:
        sess = await db.get(Session, session_id)
        if sess:
            sess.state = {**(sess.state or {}), "current_workspace": workspace}
            await db.commit()


async def _monitor_worker(session_id: str, app_state: AppState) -> None:
    """Flip worker_status when the agent container exits. Does NOT teardown
    the session — env + stream-client + vtuber keep running."""
    name = _agent_container_name(session_id)
    while True:
        proc = await asyncio.create_subprocess_exec(
            "docker", "inspect", "-f", "{{.State.Running}}", name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        if out.decode().strip() != "true":
            break
        await asyncio.sleep(5)

    # Read exit code to decide error vs clean exit.
    exit_code = 0
    proc = await asyncio.create_subprocess_exec(
        "docker", "inspect", "-f", "{{.State.ExitCode}}", name,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    try:
        exit_code = int(out.decode().strip() or "0")
    except ValueError:
        pass

    async with async_session_factory() as db:
        sess = await db.get(Session, session_id)
        if sess and sess.worker_status in ("running", "starting"):
            sess.worker_status = "error" if exit_code != 0 else "off"
            if exit_code != 0:
                sess.state = {**(sess.state or {}), "worker_exit_code": exit_code}
            await db.commit()


# ---------------------------------------------------------------------------
# teardown (end session — explicit user action)
# ---------------------------------------------------------------------------


async def teardown_session(
    session_id: str,
    kind: str,
    slot: int | None,
    app_state: AppState,
    db: AsyncSession,
    reason: str = "user",
) -> None:
    sess = await db.get(Session, session_id)
    if sess:
        sess.status = "stopping"
        await db.commit()

    m = app_state.kinds.get(kind)

    await _docker_stop(_agent_container_name(session_id))
    await reap_session_agents(session_id)
    if slot is not None:
        await streaming_svc.stop_stream_client(kind, slot)
        if m and m.topology == "separate":
            await _docker_stop(_env_container_name(kind, slot))
        await slots_svc.release_slot(kind, slot, app_state.redis)

    if sess:
        sess.status = "completed"
        sess.worker_status = "off"
        sess.ended_at = datetime.now(timezone.utc)
        if reason != "user":
            sess.state = {**(sess.state or {}), "end_reason": reason}
        await db.commit()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


async def _set_status(session_id: str, status: str) -> None:
    async with async_session_factory() as db:
        sess = await db.get(Session, session_id)
        if sess:
            sess.status = status
            await db.commit()


async def _docker_run(
    *,
    name: str,
    image: str,
    env: dict[str, str],
    volumes: list[dict[str, Any]] | None = None,
    ports: list[tuple[Any, int]] | None = None,
    remove: bool = False,
) -> str:
    await _docker_stop(name)

    cmd = ["docker", "run", "-d", "--name", name]
    if remove:
        cmd.append("--rm")
    if config.DOCKER_NETWORK:
        cmd += ["--network", config.DOCKER_NETWORK]
    for k, v in env.items():
        cmd += ["-e", f"{k}={v}"]
    for vol in volumes or []:
        mount = vol["mount"]
        name_src = vol.get("name", "")
        ro = ":ro" if vol.get("readonly") else ""
        cmd += ["-v", f"{name_src}:{mount}{ro}"]
    for proto, host_port, container_port in ports or []:
        p = f"{host_port}:{container_port}" + (f"/{proto}" if proto == "udp" else "")
        cmd += ["-p", p]
    cmd.append(image)

    logging.info(f"[env] docker run {name} (image={image})")
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"docker run {name} failed: {(err or out).decode().strip()}")
    return out.decode().strip()[:12]


async def _docker_stop(name: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "docker", "rm", "-f", name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()


async def _docker_volume_create(name: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "docker", "volume", "create", name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()


async def _docker_volume_rm(name: str) -> None:
    proc = await asyncio.create_subprocess_exec(
        "docker", "volume", "rm", "-f", name,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()


async def _container_state(name: str) -> str | None:
    proc = await asyncio.create_subprocess_exec(
        "docker", "inspect", "-f", "{{.State.Status}}", name,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    if proc.returncode != 0:
        return None
    return out.decode().strip() or None


async def _docker_logs_tail(name: str, n: int = 40) -> str:
    proc = await asyncio.create_subprocess_exec(
        "docker", "logs", "--tail", str(n), name,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    out, _ = await proc.communicate()
    return out.decode(errors="replace")


async def _wait_env_ready(hc: manifest_svc.HealthCheck, ctx: dict[str, str], host: str) -> None:
    """Poll the healthcheck AND the container state. Fail fast with log tail
    when the container exits before the check passes — so Minecraft missing
    its Fabric JAR surfaces within seconds instead of a 240s silent timeout."""
    port = int(manifest_svc.interpolate(hc.port, ctx))
    deadline = asyncio.get_event_loop().time() + hc.timeout_seconds
    while asyncio.get_event_loop().time() < deadline:
        state = await _container_state(host)
        if state in ("exited", "dead"):
            tail = await _docker_logs_tail(host, 40)
            raise RuntimeError(
                f"env container {host} exited before healthcheck passed "
                f"(state={state}).\n--- last 40 lines of docker logs {host} ---\n"
                f"{tail.strip()}"
            )
        try:
            if hc.type == "tcp_port":
                reader, writer = await asyncio.open_connection(host, port)
                writer.close()
                await writer.wait_closed()
                return
            elif hc.type == "http":
                import httpx
                async with httpx.AsyncClient() as c:
                    r = await c.get(f"http://{host}:{port}{hc.path}", timeout=5.0)
                    if r.status_code < 500:
                        return
        except Exception:
            pass
        await asyncio.sleep(2)

    # Timeout — include log tail for easier debugging.
    tail = await _docker_logs_tail(host, 40)
    raise RuntimeError(
        f"healthcheck {hc.type} on {host}:{port} timed out after {hc.timeout_seconds}s.\n"
        f"--- last 40 lines of docker logs {host} ---\n{tail.strip()}"
    )
