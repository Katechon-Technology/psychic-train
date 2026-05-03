import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import config
from ..dependencies import get_app_state, get_db, require_admin_key
from ..models import Session, SessionEvent
from ..schemas import (
    CreateSessionRequest,
    SessionInfo,
    StartAgentRequest,
    StartWorkerRequest,
    WorkspaceSwitchRequest,
)
from ..services import environment as env_svc
from ..services import slots as slots_svc
from ..state import AppState

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=SessionInfo, dependencies=[Depends(require_admin_key)])
async def create_session(
    req: CreateSessionRequest,
    background: BackgroundTasks,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    manifest = app_state.kinds.get(req.kind)
    if not manifest:
        raise HTTPException(404, f"Unknown kind: {req.kind}")

    slot = await slots_svc.claim_slot(req.kind, app_state.redis)
    if slot is None:
        raise HTTPException(503, f"No slots available for kind {req.kind}")

    sess_id = f"{req.kind}-{uuid.uuid4().hex[:8]}"
    sess = Session(
        id=sess_id,
        kind=req.kind,
        status="queued",
        slot=slot,
        state={},
    )
    db.add(sess)
    await db.commit()
    await db.refresh(sess)

    background.add_task(env_svc.spawn_session, sess_id, req.kind, slot, app_state)

    return SessionInfo.model_validate(sess)


@router.get("", response_model=list[SessionInfo])
async def list_sessions(
    status: str | None = None,
    kind: str | None = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Session).order_by(Session.created_at.desc()).limit(limit)
    if status:
        stmt = stmt.where(Session.status == status)
    if kind:
        stmt = stmt.where(Session.kind == kind)
    result = await db.execute(stmt)
    return [SessionInfo.model_validate(s) for s in result.scalars()]


@router.get("/{session_id}", response_model=SessionInfo)
async def get_session(session_id: str, db: AsyncSession = Depends(get_db)):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    return SessionInfo.model_validate(sess)


@router.delete("/{session_id}", dependencies=[Depends(require_admin_key)])
async def stop_session(
    session_id: str,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    if sess.status in ("completed", "failed"):
        return {"ok": True, "already_stopped": True}
    await env_svc.teardown_session(sess.id, sess.kind, sess.slot, app_state, db, reason="user")
    return {"ok": True}


# ---- Worker control --------------------------------------------------------


@router.post(
    "/{session_id}/worker/start",
    response_model=SessionInfo,
    status_code=202,
    dependencies=[Depends(require_admin_key)],
)
async def worker_start(
    session_id: str,
    req: StartWorkerRequest,
    background: BackgroundTasks,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    if sess.status != "waiting":
        raise HTTPException(409, f"session status is {sess.status}; must be 'waiting' to start a worker")
    if sess.worker_status not in ("off", "error"):
        raise HTTPException(409, f"worker_status is {sess.worker_status}; stop it before starting again")
    if sess.slot is None:
        raise HTTPException(409, "session has no slot")
    if not req.anthropic_api_key.strip():
        raise HTTPException(400, "anthropic_api_key is required")

    sess.worker_status = "starting"
    sess.state = {**(sess.state or {}), "worker_error": None}
    await db.commit()

    background.add_task(
        env_svc.start_worker,
        session_id,
        sess.kind,
        sess.slot,
        req.anthropic_api_key,
        req.model or config.MODEL,
        app_state,
    )
    await db.refresh(sess)
    return SessionInfo.model_validate(sess)


@router.post(
    "/{session_id}/worker/stop",
    response_model=SessionInfo,
    dependencies=[Depends(require_admin_key)],
)
async def worker_stop(
    session_id: str,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    if sess.worker_status not in ("running", "starting", "error"):
        return SessionInfo.model_validate(sess)
    await env_svc.stop_worker(session_id, app_state)
    await db.refresh(sess)
    return SessionInfo.model_validate(sess)


# ---- Livestream — pointer flip only ---------------------------------------
# The persistent vtuber-overlay container polls /api/stream/current-source and
# overlays whichever session is currently flagged livestream_status="on".
# Starting the livestream here is just a DB flip; the vtuber picks it up on
# its next 3-second poll and swaps hls.js source. RTMP to YouTube stays
# connected the entire time.


@router.post("/{session_id}/livestream/start", dependencies=[Depends(require_admin_key)])
async def livestream_start(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    if not sess.stream_url or sess.status not in ("waiting", "running"):
        raise HTTPException(409, f"preview not ready (status={sess.status})")

    # Single-active invariant: any other session that's currently "on" flips
    # to "off" so /api/stream/current-source picks this one.
    others = await db.execute(
        select(Session).where(
            Session.id != session_id,
            Session.livestream_status == "on",
        )
    )
    for other in others.scalars():
        other.livestream_status = "off"

    sess.livestream_status = "on"
    await db.commit()
    return {"ok": True, "session_id": session_id, "livestream_status": "on"}


@router.post("/{session_id}/livestream/stop", dependencies=[Depends(require_admin_key)])
async def livestream_stop(
    session_id: str,
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    sess.livestream_status = "off"
    await db.commit()
    return {"ok": True, "livestream_status": "off"}


# ---------------------------------------------------------------------------
# Multi-agent plugins (e.g. `arcade`) — per-agent lifecycle + workspace switch
# ---------------------------------------------------------------------------


def _require_multi_agent_kind(sess: Session, app_state: AppState, agent_kind: str) -> None:
    m = app_state.kinds.get(sess.kind)
    if not m or not m.agents:
        raise HTTPException(409, f"kind {sess.kind} is not a multi-agent plugin")
    if agent_kind not in m.agents:
        raise HTTPException(404, f"kind {sess.kind} has no agent named {agent_kind!r}")


@router.post(
    "/{session_id}/agents/{agent_kind}/start",
    response_model=SessionInfo,
    status_code=202,
    dependencies=[Depends(require_admin_key)],
)
async def agent_start(
    session_id: str,
    agent_kind: str,
    req: StartAgentRequest,
    background: BackgroundTasks,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    if sess.status not in ("waiting", "running"):
        raise HTTPException(409, f"session status is {sess.status}; must be 'waiting' or 'running'")
    _require_multi_agent_kind(sess, app_state, agent_kind)
    if not req.anthropic_api_key.strip():
        raise HTTPException(400, "anthropic_api_key is required")

    background.add_task(
        env_svc.start_agent,
        session_id,
        agent_kind,
        req.anthropic_api_key,
        req.model or config.MODEL,
        req.task,
        app_state,
    )
    await db.refresh(sess)
    return SessionInfo.model_validate(sess)


@router.post(
    "/{session_id}/agents/{agent_kind}/stop",
    response_model=SessionInfo,
    dependencies=[Depends(require_admin_key)],
)
async def agent_stop(
    session_id: str,
    agent_kind: str,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    _require_multi_agent_kind(sess, app_state, agent_kind)
    await env_svc.stop_agent(session_id, agent_kind)
    await db.refresh(sess)
    return SessionInfo.model_validate(sess)


@router.post(
    "/{session_id}/agents/{agent_kind}/pause",
    response_model=SessionInfo,
    dependencies=[Depends(require_admin_key)],
)
async def agent_pause(
    session_id: str,
    agent_kind: str,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    _require_multi_agent_kind(sess, app_state, agent_kind)
    await env_svc.pause_agent(session_id, agent_kind)
    await db.refresh(sess)
    return SessionInfo.model_validate(sess)


@router.post(
    "/{session_id}/agents/{agent_kind}/resume",
    response_model=SessionInfo,
    status_code=202,
    dependencies=[Depends(require_admin_key)],
)
async def agent_resume(
    session_id: str,
    agent_kind: str,
    req: StartAgentRequest,
    background: BackgroundTasks,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    _require_multi_agent_kind(sess, app_state, agent_kind)
    if not req.anthropic_api_key.strip():
        raise HTTPException(400, "anthropic_api_key is required")
    background.add_task(
        env_svc.resume_agent,
        session_id,
        agent_kind,
        req.anthropic_api_key,
        req.model or config.MODEL,
        app_state,
    )
    await db.refresh(sess)
    return SessionInfo.model_validate(sess)


@router.post(
    "/{session_id}/workspace/switch",
    dependencies=[Depends(require_admin_key)],
)
async def workspace_switch(
    session_id: str,
    req: WorkspaceSwitchRequest,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    if sess.status not in ("waiting", "running"):
        raise HTTPException(409, f"session status is {sess.status}")
    try:
        await env_svc.workspace_switch(session_id, req.workspace, app_state)
    except RuntimeError as e:
        raise HTTPException(500, str(e))
    return {"ok": True, "workspace": req.workspace}


# ---------------------------------------------------------------------------
# Demo viewer heartbeat — the /demo page in the frontend posts here every few
# seconds while it's open. tasks.agent_idle_pauser scans these keys and pauses
# every running agent on a session that hasn't been pinged recently, so we
# stop burning Anthropic credits when nobody is watching.
# ---------------------------------------------------------------------------


@router.post(
    "/{session_id}/demo/heartbeat",
    dependencies=[Depends(require_admin_key)],
)
async def demo_heartbeat(
    session_id: str,
    app_state: AppState = Depends(get_app_state),
):
    if app_state.redis is None:
        raise HTTPException(503, "redis not initialized")
    now_ts = datetime.now(timezone.utc).timestamp()
    # TTL is a soft upper bound; the periodic checker uses the value, not the
    # TTL, to decide whether the heartbeat is fresh.
    await app_state.redis.set(
        f"demo_heartbeat:{session_id}", str(now_ts), ex=120
    )
    return {"ok": True, "ts": now_ts}


# ---------------------------------------------------------------------------
# Session events — agent POSTs here; narrator GETs here (works across servers)
# ---------------------------------------------------------------------------

@router.post("/{session_id}/events", dependencies=[Depends(require_admin_key)])
async def post_event(
    session_id: str,
    payload: dict,
    db: AsyncSession = Depends(get_db),
):
    db.add(SessionEvent(session_id=session_id, event=payload))
    await db.commit()
    return {"ok": True}


@router.get("/{session_id}/events")
async def get_events(
    session_id: str,
    after: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(SessionEvent)
        .where(SessionEvent.session_id == session_id, SessionEvent.id > after)
        .order_by(SessionEvent.id)
        .limit(limit)
    )
    rows = result.scalars().all()
    return [{"id": r.id, "event": r.event} for r in rows]
