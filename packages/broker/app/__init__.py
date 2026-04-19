import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .db import init_db, close_db
from .routes import all_routers
from .services.manifest import load_registry
from .state import AppState
from .tasks import session_timeout_checker


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
        yield
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
