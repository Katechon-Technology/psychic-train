from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from .config import config
from .models import Base

DATABASE_URL = (
    f"postgresql+asyncpg://{config.POSTGRES_USER}:{config.POSTGRES_PASSWORD}"
    f"@{config.POSTGRES_HOST}/{config.POSTGRES_DB}"
)

engine = create_async_engine(DATABASE_URL, pool_size=20, max_overflow=0)
async_session_factory = async_sessionmaker(engine, expire_on_commit=False)


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Idempotent migrations for columns added after the initial schema.
        from sqlalchemy import text
        await conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS "
            "livestream_status VARCHAR NOT NULL DEFAULT 'off'"
        ))
        await conn.execute(text(
            "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS "
            "worker_status VARCHAR NOT NULL DEFAULT 'off'"
        ))


async def close_db():
    await engine.dispose()
