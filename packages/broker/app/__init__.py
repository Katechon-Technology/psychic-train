import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import select

from .db import async_session_factory, init_db, close_db
from .models import Session as SessionModel
from .routes import all_routers
from .services.environment import teardown_session
from .services.manifest import load_registry
from .state import AppState
from .tasks import agent_idle_pauser, session_timeout_checker


# Statuses where containers may still be running and need to be reaped.
ALIVE_SESSION_STATUSES = ("queued", "starting", "waiting", "running", "stopping")


async def _teardown_alive_sessions(app_state: AppState) -> None:
    """On broker shutdown, reap every session whose containers may still be
    running so the host doesn't leak orphans. Best-effort — failures are
    logged but never raised, otherwise a hung teardown would block the
    SIGTERM handler and the broker would be killed mid-cleanup."""
    async with async_session_factory() as db:
        result = await db.execute(
            select(SessionModel).where(SessionModel.status.in_(ALIVE_SESSION_STATUSES))
        )
        sessions = list(result.scalars())

    if not sessions:
        logging.info("[shutdown] no alive sessions to reap")
        return

    logging.info(f"[shutdown] reaping {len(sessions)} session(s): {[s.id for s in sessions]}")

    async def _reap(sess: SessionModel) -> None:
        try:
            async with async_session_factory() as db:
                await teardown_session(
                    sess.id, sess.kind, sess.slot, app_state, db, reason="broker_shutdown"
                )
            logging.info(f"[shutdown] reaped {sess.id} ({sess.kind} slot={sess.slot})")
        except Exception as e:
            logging.error(f"[shutdown] teardown {sess.id} failed: {e}")

    # Parallel — docker compose's default stop_grace_period is 10s. Each
    # teardown does a docker rm -f via stream-agent HTTP plus a few local
    # docker calls, so two sessions sequentially can blow past that
    # (and SIGKILL would skip the rest of the cleanup).
    await asyncio.gather(*(_reap(s) for s in sessions), return_exceptions=True)


def create_app() -> FastAPI:
    app_state = AppState()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await init_db()
        await app_state.init_redis()
        app_state.kinds = load_registry()
        logging.info(f"Loaded {len(app_state.kinds)} kind(s): {list(app_state.kinds)}")
        # Pre-populate slot pools in Redis (one set per kind, size = manifest.max_concurrent)
        await app_state.init_slot_pools()
        asyncio.create_task(session_timeout_checker(app_state))
        asyncio.create_task(agent_idle_pauser(app_state))
        yield
        # Teardown order matters: reap sessions BEFORE closing redis (slot
        # release writes to redis) and BEFORE closing the DB (teardown
        # commits the session row to status=completed).
        try:
            await _teardown_alive_sessions(app_state)
        except Exception as e:
            logging.error(f"[shutdown] alive-session reap raised: {e}")
        await app_state.close_redis()
        await close_db()

    app = FastAPI(
        title="psychic-train broker",
        description="Generalized on-demand AI environment orchestrator",
        version="0.1.0",
        lifespan=lifespan,
    )

    app.state.app_state = app_state

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(RequestValidationError)
    async def log_validation_error(request: Request, exc: RequestValidationError):
        logging.warning(f"422 on {request.method} {request.url.path}: {exc.errors()}")
        return JSONResponse(status_code=422, content={"detail": exc.errors()})

    for router in all_routers:
        app.include_router(router)

    return app
