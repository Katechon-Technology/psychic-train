import asyncio
import logging
from datetime import datetime, timezone, timedelta

from sqlalchemy import select

from .config import config
from .db import async_session_factory
from .models import Session
from .services import environment as env_svc
from .state import AppState


# Demo idle-pauser tunables. The /demo frontend posts a heartbeat every ~5s;
# we pause agents once we've gone DEMO_IDLE_CUTOFF_SECONDS without one. The
# grace period stops us from pausing a freshly-spawned session before its
# viewer's first heartbeat lands.
DEMO_KIND = "arcade"
DEMO_IDLE_CUTOFF_SECONDS = 20
DEMO_IDLE_GRACE_SECONDS = 30


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


async def agent_idle_pauser(app_state: AppState):
    """Background loop: pause every running agent on a demo session whose
    /demo viewer has stopped pinging."""
    while True:
        try:
            await _idle_check_once(app_state)
        except Exception as e:
            logging.warning(f"agent_idle_pauser: {e}")
        await asyncio.sleep(5)


async def _idle_check_once(app_state: AppState):
    redis = app_state.redis
    if redis is None:
        return
    now = datetime.now(timezone.utc)
    now_ts = now.timestamp()
    async with async_session_factory() as db:
        result = await db.execute(
            select(Session)
            .where(Session.kind == DEMO_KIND)
            .where(Session.status.in_(["waiting", "running"]))
        )
        sessions = list(result.scalars())

    for sess in sessions:
        # Don't punish a freshly-started session whose viewer hasn't sent a
        # heartbeat yet.
        anchor = sess.started_at or sess.created_at
        if anchor is not None and (now - anchor).total_seconds() < DEMO_IDLE_GRACE_SECONDS:
            continue

        last_hb_raw = await redis.get(f"demo_heartbeat:{sess.id}")
        if last_hb_raw is not None:
            try:
                last_hb = float(last_hb_raw)
            except ValueError:
                last_hb = 0.0
            if (now_ts - last_hb) <= DEMO_IDLE_CUTOFF_SECONDS:
                continue  # fresh heartbeat — leave the agents alone

        agents = (sess.state or {}).get("agents") or {}
        for agent_kind, info in agents.items():
            status = (info or {}).get("status")
            if status not in ("running", "starting"):
                continue
            try:
                await env_svc.pause_agent(sess.id, agent_kind)
                logging.info(
                    f"[idle] paused {sess.id}/{agent_kind} (no heartbeat in >{DEMO_IDLE_CUTOFF_SECONDS}s)"
                )
            except Exception as e:
                logging.warning(f"[idle] pause failed for {sess.id}/{agent_kind}: {e}")
