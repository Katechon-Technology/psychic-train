"""Stream-agent: spawns kind-specific stream-client containers on the stream server
at the broker's request. Kind-agnostic — the broker sends the image name, env vars,
and host port in the request payload."""

import asyncio
import os
import shutil

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

STREAM_AGENT_KEY = os.getenv("STREAM_AGENT_KEY", "")
DOCKER_NETWORK_DEFAULT = os.getenv("DOCKER_NETWORK", "psychic_train_net")
VTUBER_MODELS_PATH = os.getenv("VTUBER_MODELS_PATH", "")
HLS_READY_TIMEOUT_SECONDS = 180
VTUBER_READY_TIMEOUT_SECONDS = 400


def require_auth(x_stream_agent_key: str = Header(...)):
    if STREAM_AGENT_KEY and x_stream_agent_key != STREAM_AGENT_KEY:
        raise HTTPException(status_code=401, detail="Unauthorized")


app = FastAPI(title="psychic-train stream-agent")


@app.get("/health")
async def health():
    return {"ok": True}


class SpawnRequest(BaseModel):
    container_name: str
    image: str
    host_port: int | None = None     # None → container stays private (no -p)
    extra_ports: list[dict] = []     # [{"host": int, "container": int}] additional port mappings
    env: dict[str, str] = {}
    network: str = ""
    volumes: list[dict] = []          # [{"name": "<vol>", "mount": "<path>", "readonly": bool}]


async def _spawn_and_wait_hls(req: SpawnRequest, readiness_timeout: int) -> dict:
    _ensure_docker_available()
    await _stop_container(req.container_name)

    network = req.network or DOCKER_NETWORK_DEFAULT

    cmd = ["docker", "run", "-d", "--name", req.container_name]
    if network:
        cmd += ["--network", network]
    for k, v in req.env.items():
        cmd += ["-e", f"{k}={v}"]
    for vol in req.volumes:
        ro = ":ro" if vol.get("readonly") else ""
        cmd += ["-v", f"{vol['name']}:{vol['mount']}{ro}"]
    if req.host_port is not None:
        cmd += ["-p", f"{req.host_port}:3000"]
    for ep in req.extra_ports:
        cmd += ["-p", f"{ep['host']}:{ep['container']}"]
    cmd += [req.image]

    print(
        f"[stream-agent] spawn {req.container_name} image={req.image} "
        f"host_port={req.host_port} vols={len(req.volumes)}",
        flush=True,
    )

    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        msg = (err or out or b"").decode().strip()
        print(f"[stream-agent] ERROR: {msg}", flush=True)
        raise HTTPException(500, f"docker run failed: {msg}")

    if not await _wait_for_port(req.container_name, 3000, timeout=readiness_timeout):
        raise HTTPException(504, "port 3000 not ready")
    if not await _wait_for_file(req.container_name, "/tmp/hls/stream.m3u8", timeout=readiness_timeout):
        raise HTTPException(504, "HLS manifest not produced")
    return {"ok": True}


@app.post("/spawn/stream-client")
async def spawn_stream_client(req: SpawnRequest, _=Depends(require_auth)):
    return await _spawn_and_wait_hls(req, readiness_timeout=HLS_READY_TIMEOUT_SECONDS)


@app.post("/spawn/vtuber-overlay")
async def spawn_vtuber_overlay(req: SpawnRequest, _=Depends(require_auth)):
    # VTuber containers take longer to come up (Open-LLM-VTuber server + Chrome).
    # Inject ASR models volume if configured on this host.
    if VTUBER_MODELS_PATH:
        req.volumes = list(req.volumes) + [
            {"name": VTUBER_MODELS_PATH, "mount": "/models-src", "readonly": True}
        ]
    return await _spawn_and_wait_hls(req, readiness_timeout=VTUBER_READY_TIMEOUT_SECONDS)


@app.post("/volumes/{name}")
async def volume_create(name: str, _=Depends(require_auth)):
    _ensure_docker_available()
    proc = await asyncio.create_subprocess_exec(
        "docker", "volume", "create", name,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(500, f"volume create failed: {err.decode().strip()}")
    return {"ok": True, "name": name}


@app.delete("/volumes/{name}")
async def volume_delete(name: str, _=Depends(require_auth)):
    _ensure_docker_available()
    proc = await asyncio.create_subprocess_exec(
        "docker", "volume", "rm", "-f", name,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    return {"ok": True}


@app.post("/containers/{name}/rtmp/start")
async def rtmp_start(name: str, _=Depends(require_auth)):
    """Exec /scripts/start-rtmp.sh inside a running vtuber-overlay container."""
    _ensure_docker_available()
    proc = await asyncio.create_subprocess_exec(
        "docker", "exec", name, "/scripts/start-rtmp.sh",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(500, (err or out or b"").decode().strip() or "rtmp start failed")
    return {"ok": True, "output": out.decode().strip()}


@app.post("/containers/{name}/rtmp/stop")
async def rtmp_stop(name: str, _=Depends(require_auth)):
    _ensure_docker_available()
    proc = await asyncio.create_subprocess_exec(
        "docker", "exec", name, "/scripts/stop-rtmp.sh",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(500, (err or out or b"").decode().strip() or "rtmp stop failed")
    return {"ok": True, "output": out.decode().strip()}


@app.delete("/containers/{name}")
async def delete_container(name: str, _=Depends(require_auth)):
    _ensure_docker_available()
    await _stop_container(name)
    return {"ok": True}


async def _stop_container(name: str) -> None:
    try:
        _ensure_docker_available()
        proc = await asyncio.create_subprocess_exec(
            "docker", "rm", "-f", name,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
    except Exception:
        pass


async def _wait_for_port(host: str, port: int, timeout: int = 120) -> bool:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        try:
            reader, writer = await asyncio.open_connection(host, port)
            writer.close()
            await writer.wait_closed()
            return True
        except Exception:
            await asyncio.sleep(2)
    return False


async def _wait_for_file(container_name: str, path: str, timeout: int) -> bool:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        proc = await asyncio.create_subprocess_exec(
            "docker", "exec", container_name, "test", "-f", path,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await proc.wait()
        if proc.returncode == 0:
            return True
        await asyncio.sleep(3)
    return False


def _ensure_docker_available() -> None:
    if not shutil.which("docker"):
        raise HTTPException(500, "docker CLI not found inside stream-agent")
    if not os.path.exists("/var/run/docker.sock"):
        raise HTTPException(500, "/var/run/docker.sock not mounted")
