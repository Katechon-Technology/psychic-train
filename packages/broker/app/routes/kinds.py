from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..dependencies import get_app_state, get_db
from ..models import Session
from ..schemas import KindInfo
from ..state import AppState

router = APIRouter(prefix="/api/kinds", tags=["kinds"])


@router.get("", response_model=list[KindInfo])
async def list_kinds(app_state: AppState = Depends(get_app_state), db: AsyncSession = Depends(get_db)):
    # Count active sessions per kind in one query
    counts_result = await db.execute(
        select(Session.kind, func.count(Session.id))
        .where(Session.status.in_(["starting", "running"]))
        .group_by(Session.kind)
    )
    counts = {row[0]: row[1] for row in counts_result.all()}

    return [
        KindInfo(
            name=m.name,
            display_name=m.display_name,
            description=m.description,
            topology=m.topology,
            max_concurrent=m.max_concurrent,
            active_sessions=counts.get(m.name, 0),
        )
        for m in app_state.kinds.values()
    ]


@router.get("/{name}", response_model=KindInfo)
async def get_kind(name: str, app_state: AppState = Depends(get_app_state), db: AsyncSession = Depends(get_db)):
    manifest = app_state.kinds.get(name)
    if not manifest:
        raise HTTPException(404, f"Unknown kind: {name}")
    count_result = await db.execute(
        select(func.count(Session.id))
        .where(Session.kind == name)
        .where(Session.status.in_(["starting", "running"]))
    )
    return KindInfo(
        name=manifest.name,
        display_name=manifest.display_name,
        description=manifest.description,
        topology=manifest.topology,
        max_concurrent=manifest.max_concurrent,
        active_sessions=count_result.scalar() or 0,
    )
