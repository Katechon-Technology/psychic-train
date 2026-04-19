from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class KindInfo(BaseModel):
    name: str
    display_name: str
    description: str
    topology: str
    max_concurrent: int
    active_sessions: int


class CreateSessionRequest(BaseModel):
    kind: str


class StartWorkerRequest(BaseModel):
    anthropic_api_key: str
    model: Optional[str] = None  # falls back to broker config.MODEL if omitted


class SessionInfo(BaseModel):
    id: str
    kind: str
    status: str
    slot: Optional[int]
    stream_url: Optional[str]
    worker_status: str = "off"
    livestream_status: str = "off"
    state: dict[str, Any]
    error: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    ended_at: Optional[datetime]

    class Config:
        from_attributes = True
