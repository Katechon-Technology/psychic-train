import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


class Config:
    # Database
    POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
    POSTGRES_DB = os.getenv("POSTGRES_DB", "psychic_train")
    POSTGRES_USER = os.getenv("POSTGRES_USER", "psychic_train")
    POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "psychic_train_secret_123")
    REDIS_HOST = os.getenv("REDIS_HOST", "localhost")

    # Plugin registry
    PLUGINS_DIR = Path(os.getenv("PLUGINS_DIR", "/plugins"))

    # Session TTL
    SESSION_TTL_SECONDS = int(os.getenv("SESSION_TTL_SECONDS", "600"))  # 10 min default

    # Auth
    BROKER_ADMIN_KEY = os.getenv("BROKER_ADMIN_KEY", "")

    # Container runtime
    DOCKER_NETWORK = os.getenv("DOCKER_NETWORK", "psychic_train_net")

    # Streaming endpoint (port-based routing for dev, subdomain for prod if STREAM_DOMAIN set)
    STREAM_BASE_PORT = int(os.getenv("STREAM_BASE_PORT", "3003"))
    VTUBER_BASE_PORT = int(os.getenv("VTUBER_BASE_PORT", "3053"))
    STREAM_SCHEME = os.getenv("STREAM_SCHEME", "http")
    STREAM_PUBLIC_HOST = os.getenv("STREAM_PUBLIC_HOST", "localhost")
    STREAM_DOMAIN = os.getenv("STREAM_DOMAIN", "")

    # Two-server prod split (optional)
    STREAM_AGENT_URL = os.getenv("STREAM_AGENT_URL", "")
    STREAM_AGENT_KEY = os.getenv("STREAM_AGENT_KEY", "")
    GAME_SERVER_PUBLIC_HOST = os.getenv("GAME_SERVER_PUBLIC_HOST", "")

    # Secrets passed through to agent containers
    ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
    RCON_PASSWORD = os.getenv("RCON_PASSWORD", "psychic_train_rcon")
    MODEL = os.getenv("MODEL", "claude-sonnet-4-5-20250929")

    # VTuber overlay
    VTUBER_OVERLAY_IMAGE = os.getenv("VTUBER_OVERLAY_IMAGE", "psychic-train/vtuber-overlay:latest")
    ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
    NARRATION_MODEL = os.getenv("NARRATION_MODEL", "claude-haiku-4-5-20251001")
    YOUTUBE_STREAM_KEY = os.getenv("YOUTUBE_STREAM_KEY", "")

    # Broker's externally visible URL (passed to agent containers so they can call back)
    BROKER_URL = os.getenv("BROKER_URL", "http://broker:8080")

    @classmethod
    def stream_url_for_slot(cls, slot: int, kind: str) -> str:
        """Public URL where viewers can load /stream.m3u8 for this slot."""
        if cls.STREAM_DOMAIN:
            return f"{cls.STREAM_SCHEME}://{kind}{slot}.{cls.STREAM_DOMAIN}/"
        port = cls.STREAM_BASE_PORT + slot
        return f"{cls.STREAM_SCHEME}://{cls.STREAM_PUBLIC_HOST}:{port}/"

    @classmethod
    def vtuber_url_for_slot(cls, slot: int, kind: str) -> str:
        """Public URL for the vtuber overlay HLS for this slot."""
        if cls.STREAM_DOMAIN:
            return f"{cls.STREAM_SCHEME}://vtuber-{kind}{slot}.{cls.STREAM_DOMAIN}/"
        port = cls.VTUBER_BASE_PORT + slot
        return f"{cls.STREAM_SCHEME}://{cls.STREAM_PUBLIC_HOST}:{port}/"


config = Config()
