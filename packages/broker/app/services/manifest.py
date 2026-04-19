"""Plugin manifest loader. Reads plugins/*/manifest.yaml at broker startup into an
in-memory registry. Also handles template-variable interpolation."""

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from ..config import config


@dataclass
class PortSpec:
    name: str
    protocol: str  # "tcp" | "udp"
    base: int


@dataclass
class HealthCheck:
    type: str          # "tcp_port" | "http" | "rcon_command"
    port: str          # template string like "{rcon_port}"
    path: str = "/"    # for http
    timeout_seconds: int = 60


@dataclass
class ContainerSpec:
    image: str
    env: dict[str, str] = field(default_factory=dict)
    volumes: list[dict[str, Any]] = field(default_factory=list)
    healthcheck: HealthCheck | None = None


@dataclass
class StreamClientSpec:
    image: str
    env: dict[str, str] = field(default_factory=dict)
    # [{name: <volume>, mount: <path>, readonly: <bool>}] — mounted when the
    # broker docker-run's this stream-client. Useful for plugins that keep
    # large / proprietary assets out of the image (e.g. factorio-client).
    volumes: list[dict[str, Any]] = field(default_factory=list)
    display_width: int = 1280
    display_height: int = 720
    display_fps: int = 30


@dataclass
class NarrationSpec:
    enabled: bool = True
    character_name: str = "Claude"
    live2d_model: str = "mao_pro"
    voice_id: str = "jqcCZkN6Knx8BJ5TBdYR"
    system_prompt: str = ""
    mood_hints: str = ""
    persona_prompt: str = ""


@dataclass
class Manifest:
    name: str
    display_name: str
    description: str
    topology: str               # "separate" | "combined"
    max_concurrent: int
    ports: list[PortSpec]
    environment: ContainerSpec | None  # None when topology=="combined"
    agent: ContainerSpec
    stream_client: StreamClientSpec
    narration: NarrationSpec | None = None  # None ⇒ no avatar overlay for this kind


def _parse_container(d: dict) -> ContainerSpec:
    hc = None
    if d.get("healthcheck"):
        hc = HealthCheck(**d["healthcheck"])
    return ContainerSpec(
        image=d["image"],
        env=d.get("env", {}),
        volumes=d.get("volumes", []),
        healthcheck=hc,
    )


def _parse_stream_client(d: dict) -> StreamClientSpec:
    display = d.get("display", {}) or {}
    return StreamClientSpec(
        image=d["image"],
        env=d.get("env", {}),
        volumes=d.get("volumes", []),
        display_width=display.get("width", 1280),
        display_height=display.get("height", 720),
        display_fps=display.get("fps", 30),
    )


def _parse_narration(d: dict) -> NarrationSpec | None:
    if not d:
        return None
    spec = NarrationSpec(
        enabled=bool(d.get("enabled", True)),
        character_name=d.get("character_name", "Claude"),
        live2d_model=d.get("live2d_model", "mao_pro"),
        voice_id=d.get("voice_id", "jqcCZkN6Knx8BJ5TBdYR"),
        system_prompt=(d.get("system_prompt") or "").strip(),
        mood_hints=(d.get("mood_hints") or "").strip(),
        persona_prompt=(d.get("persona_prompt") or "").strip(),
    )
    return spec if spec.enabled else None


def parse_manifest(path: Path) -> Manifest:
    data = yaml.safe_load(path.read_text())
    topology = data.get("topology", "separate")
    ports = [PortSpec(**p) for p in data.get("ports", [])]
    env_spec = _parse_container(data["environment"]) if topology == "separate" else None
    return Manifest(
        name=data["name"],
        display_name=data.get("display_name", data["name"]),
        description=data.get("description", ""),
        topology=topology,
        max_concurrent=int(data.get("max_concurrent", 3)),
        ports=ports,
        environment=env_spec,
        agent=_parse_container(data["agent"]),
        stream_client=_parse_stream_client(data["stream_client"]),
        narration=_parse_narration(data.get("narration")),
    )


def load_registry(plugins_dir: Path | None = None) -> dict[str, Manifest]:
    d = plugins_dir or config.PLUGINS_DIR
    registry: dict[str, Manifest] = {}
    if not d.exists():
        logging.warning(f"Plugins dir {d} does not exist")
        return registry
    for child in sorted(d.iterdir()):
        manifest_file = child / "manifest.yaml"
        if not manifest_file.is_file():
            continue
        try:
            m = parse_manifest(manifest_file)
            registry[m.name] = m
        except Exception as e:
            logging.error(f"Failed to parse {manifest_file}: {e}")
    return registry


def build_context(
    *,
    slot: int,
    session_id: str,
    kind: str,
    ports: list[PortSpec],
    env_host: str,
    combined: bool,
) -> dict[str, str]:
    """Template context for env var interpolation. Secrets come from Config."""
    ctx: dict[str, str] = {
        "slot": str(slot),
        "session_id": session_id,
        "kind": kind,
        "env_host": env_host,
        "broker_url": config.BROKER_URL,
        "broker_api_key": config.BROKER_ADMIN_KEY,
        "rcon_password": config.RCON_PASSWORD,
        "anthropic_api_key": config.ANTHROPIC_API_KEY,
        "model": config.MODEL,
    }
    for p in ports:
        # _port = host-visible port (base + slot); use this for external URLs.
        # _internal = container-internal port (base); use this for inter-container
        # communication on the shared docker network, and for healthchecks the broker
        # runs against the env container.
        ctx[f"{p.name}_port"] = str(p.base + slot)
        ctx[f"{p.name}_internal"] = str(p.base)
    return ctx


def interpolate(value: str, ctx: dict[str, str]) -> str:
    """Replace `{key}` occurrences with ctx values; leave unknown tokens untouched."""
    try:
        return value.format_map(_SafeDict(ctx))
    except Exception:
        return value


class _SafeDict(dict):
    def __missing__(self, key):
        return "{" + key + "}"


def interpolate_env(env: dict[str, str], ctx: dict[str, str]) -> dict[str, str]:
    return {k: interpolate(str(v), ctx) for k, v in env.items()}
