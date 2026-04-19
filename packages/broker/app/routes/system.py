from fastapi import APIRouter, Depends

from ..dependencies import get_app_state
from ..state import AppState

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
async def health():
    return {"ok": True}


@router.get("/status")
async def status(app_state: AppState = Depends(get_app_state)):
    return {
        "kinds_loaded": list(app_state.kinds),
        "redis_ok": app_state.redis is not None,
    }
