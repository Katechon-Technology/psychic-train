from datetime import datetime, timezone

from sqlalchemy import Column, DateTime, Integer, String, JSON
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


class SessionEvent(Base):
    __tablename__ = "session_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    session_id = Column(String, nullable=False, index=True)
    event = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))


class Session(Base):
    __tablename__ = "sessions"

    id = Column(String, primary_key=True)
    kind = Column(String, nullable=False, index=True)
    # queued → starting → waiting (env + stream up, no worker) → stopping →
    # completed | failed. The agent is NOT auto-spawned; user clicks Start
    # Worker to launch it.
    status = Column(String, nullable=False, index=True)
    slot = Column(Integer, nullable=True)
    stream_url = Column(String, nullable=True)
    # off | starting | running | stopping | error — orthogonal to status.
    # Flips on when the user clicks "Start Worker" in the UI.
    worker_status = Column(String, nullable=False, default="off")
    # off | starting | on | error — the RTMP push (toggled via /livestream).
    livestream_status = Column(String, nullable=False, default="off")
    state = Column(JSON, nullable=False, default=dict)
    error = Column(String, nullable=True)

    created_at = Column(DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc))
    started_at = Column(DateTime(timezone=True), nullable=True)
    ended_at = Column(DateTime(timezone=True), nullable=True)
