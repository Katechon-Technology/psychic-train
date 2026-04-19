import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from .config import config
from .db import async_session_factory
from .models import Session
from .services import environment as env_svc
from .state import AppState


async def session_timeout_checker(app_state: AppState):
    """Background loop: kill sessions that have been running past SESSION_TTL_SECONDS."""
    while True:
        try:
            await _check_once(app_state)
        except Exception as e:
            logging.warning(f"session_timeout_checker: {e}")
        await asyncio.sleep(30)


async def _check_once(app_state: AppState):
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=config.SESSION_TTL_SECONDS)
    async with async_session_factory() as db:
        result = await db.execute(
            select(Session).where(Session.status == "running").where(Session.started_at < cutoff)
        )
        for sess in result.scalars():
            logging.info(f"Timing out session {sess.id} (kind={sess.kind})")
            await env_svc.teardown_session(sess.id, sess.kind, sess.slot, app_state, db, reason="ttl")
