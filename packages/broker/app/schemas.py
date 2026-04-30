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


class StartAgentRequest(BaseModel):
    """Body for POST /sessions/{id}/agents/{kind}/start (and /resume)."""
    anthropic_api_key: str
    model: Optional[str] = None
    task: Optional[str] = None  # piped through to the agent as TASK_HINT env var


class WorkspaceSwitchRequest(BaseModel):
    workspace: int  # 0-indexed openbox desktop number


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
