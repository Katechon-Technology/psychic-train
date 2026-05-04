"""Narration control — frontend supplies the Anthropic API key and starts a
per-session narrator task that lives inside the broker process. The task
writes narration text into session_events as `kind: "narration"`."""

from fastapi import APIRouter, Depends, HTTPException, Request

from ..dependencies import get_app_state, require_admin_key
from ..services import narrator as narrator_svc
from ..services.manifest import NarrationSpec
from ..state import AppState

router = APIRouter(prefix="/api/sessions", tags=["narration"])


@router.post(
    "/{session_id}/narration/start",
    dependencies=[Depends(require_admin_key)],
)
async def narration_start(
    session_id: str,
    payload: dict,
    request: Request,
    app_state: AppState = Depends(get_app_state),
):
    api_key = str(payload.get("anthropic_api_key", "")).strip()
    if not api_key:
        raise HTTPException(400, "anthropic_api_key is required")

    # Pull defaults from the manifest's narration: block when present; the
    # caller may override system_prompt / mood_hints / model.
    sess = await _get_session_or_404(app_state, session_id)
    manifest = app_state.kinds.get(sess.kind)
    spec: NarrationSpec | None = manifest.narration if manifest else None

    cfg = narrator_svc.NarratorConfig(
        anthropic_api_key=api_key,
        model=str(payload.get("model") or narrator_svc.DEFAULT_NARRATION_MODEL),
        system_prompt=str(
            payload.get("system_prompt")
            or (spec.system_prompt if spec and spec.system_prompt else narrator_svc.DEFAULT_SYSTEM_PROMPT)
        ),
        mood_hints=str(
            payload.get("mood_hints")
            or (spec.mood_hints if spec else "")
        ),
    )
    fresh = narrator_svc.start(session_id, cfg, app_state)
    return {"ok": True, "session_id": session_id, "fresh": fresh}


@router.post(
    "/{session_id}/narration/stop",
    dependencies=[Depends(require_admin_key)],
)
async def narration_stop(
    session_id: str,
    app_state: AppState = Depends(get_app_state),
):
    cancelled = narrator_svc.stop(session_id, app_state)
    return {"ok": True, "cancelled": cancelled}


async def _get_session_or_404(app_state: AppState, session_id: str):
    from ..db import async_session_factory
    from ..models import Session as SessionModel
    async with async_session_factory() as db:
        sess = await db.get(SessionModel, session_id)
        if not sess:
            raise HTTPException(404, f"Unknown session: {session_id}")
        return sess
