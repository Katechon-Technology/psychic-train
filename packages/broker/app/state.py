import asyncio
from typing import Any, Dict

import redis.asyncio as redis

from .config import config


class AppState:
    def __init__(self):
        self.redis: redis.Redis | None = None
        self.kinds: dict[str, Any] = {}           # name -> Manifest (populated in lifespan)
        self.session_tasks: Dict[str, asyncio.Task] = {}  # session_id -> monitor task
        self.narrator_tasks: Dict[str, asyncio.Task] = {}  # session_id -> narrator loop

    async def init_redis(self):
        self.redis = redis.Redis(
            host=config.REDIS_HOST,
            port=6379,
            decode_responses=True,
        )

    async def init_slot_pools(self):
        """Pre-populate Redis sets `slots:{kind}` with 0..max_concurrent-1 for each kind.
        Idempotent: uses SADD which is a no-op when the member exists."""
        assert self.redis is not None
        for name, manifest in self.kinds.items():
            key = f"slots:{name}"
            for slot in range(manifest.max_concurrent):
                await self.redis.sadd(key, str(slot))

    async def close_redis(self):
        if self.redis:
            await self.redis.close()
