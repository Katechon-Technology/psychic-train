import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import config
from ..dependencies import get_app_state, get_db, require_admin_key
from ..models import Session
from ..schemas import CreateSessionRequest, SessionInfo, StartWorkerRequest
from ..services import environment as env_svc
from ..services import slots as slots_svc
from ..services import streaming as streaming_svc
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


# ---- Livestream (RTMP) -----------------------------------------------------


@router.post("/{session_id}/livestream/start", dependencies=[Depends(require_admin_key)])
async def livestream_start(
    session_id: str,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    # Gate on stream_url — livestream works whenever the preview is up,
    # regardless of whether a worker is currently running.
    if not sess.stream_url or sess.status not in ("waiting", "running"):
        raise HTTPException(409, f"preview not ready (status={sess.status})")
    m = app_state.kinds.get(sess.kind)
    if not m or not m.narration:
        raise HTTPException(409, f"kind {sess.kind} has no vtuber overlay — nothing to RTMP-push from")
    if sess.slot is None:
        raise HTTPException(409, "session has no slot")
    sess.livestream_status = "starting"
    await db.commit()

    # start_livestream now SPAWNS the vtuber overlay (it didn't exist at
    # session-creation time) and then kicks off the RTMP side-car inside it.
    log_volume = f"session-logs-{sess.id}"
    ok, msg = await streaming_svc.start_livestream(
        kind=sess.kind,
        slot=sess.slot,
        session_id=sess.id,
        narration=m.narration,
        log_volume=log_volume,
    )
    if ok:
        sess.stream_url = config.vtuber_url_for_slot(sess.slot, sess.kind)
        sess.livestream_status = "on"
    else:
        sess.livestream_status = "error"
        sess.state = {**(sess.state or {}), "livestream_error": msg}
    await db.commit()
    if not ok:
        raise HTTPException(500, f"livestream start failed: {msg}")
    return {"ok": True, "stream_url": sess.stream_url, "livestream_status": sess.livestream_status}


@router.post("/{session_id}/livestream/stop", dependencies=[Depends(require_admin_key)])
async def livestream_stop(
    session_id: str,
    app_state: AppState = Depends(get_app_state),
    db: AsyncSession = Depends(get_db),
):
    sess = await db.get(Session, session_id)
    if not sess:
        raise HTTPException(404, f"Unknown session: {session_id}")
    if sess.slot is None:
        return {"ok": True, "livestream_status": "off"}
    ok, msg = await streaming_svc.stop_livestream(sess.kind, sess.slot)
    await streaming_svc.stop_vtuber_overlay(sess.kind, sess.slot)
    sess.stream_url = None
    sess.livestream_status = "off" if ok else "error"
    await db.commit()
    if not ok:
        raise HTTPException(500, f"stop-rtmp failed: {msg}")
    return {"ok": True, "livestream_status": sess.livestream_status, "output": msg}
