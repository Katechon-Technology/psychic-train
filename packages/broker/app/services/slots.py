"""Slot allocation — each kind has its own Redis set `slots:{kind}` pre-populated
with slot numbers 0..max_concurrent-1 at broker startup. Claim = SPOP, release = SADD."""

from typing import Optional

import redis.asyncio as redis


async def claim_slot(kind: str, r: redis.Redis) -> Optional[int]:
    val = await r.spop(f"slots:{kind}")
    return int(val) if val is not None else None


async def release_slot(kind: str, slot: int, r: redis.Redis) -> None:
    await r.sadd(f"slots:{kind}", str(slot))
