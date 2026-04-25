"""Endpoints consumed by the persistent vtuber-overlay container.

The vtuber polls /api/stream/current-source to know which session's HLS to
overlay right now. When a user clicks "Start Livestream" on a session, that
session's livestream_status flips to "on" (and any previously-on session
flips off — single-active invariant enforced in routes/sessions.py). The
vtuber's wrapper.html sees the URL change on its next 3-second poll and
swaps hls.js source without reconnecting RTMP.

Phase 1: live-only. When no session is "on", returns {type: "none"} and
the wrapper falls back to a static standby page. Phase 2 will replace the
"none" branch with a random pick from archived sessions.
"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_db
from ..models import Session

router = APIRouter(prefix="/api/stream", tags=["stream"])


@router.get("/current-source")
async def current_source(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Session)
        .where(Session.livestream_status == "on")
        .order_by(Session.created_at.desc())
        .limit(1)
    )
    live = result.scalar_one_or_none()
    if live and live.stream_url:
        url = live.stream_url.rstrip("/") + "/stream.m3u8"
        return {"type": "live", "session_id": live.id, "url": url}
    return {"type": "none", "url": ""}
