from .kinds import router as kinds_router
from .sessions import router as sessions_router
from .stream import router as stream_router
from .system import router as system_router

all_routers = [kinds_router, sessions_router, stream_router, system_router]
