"""Per-session narration generator.

Ported from packages/vtuber-overlay/narrate.py and adapted to run as an
asyncio task inside the broker. Writes narration text directly into
session_events as `kind: "narration"`. The /demo viewer polls these events
and TTSes them locally; (later) the production VTuber container can do the
same plus synthesize audio.

Each narrator task owns one session_id. Started by POST /api/sessions/{id}
/narration/start with the caller-supplied Anthropic API key (the broker
itself does NOT hold a fallback key for narration). Stopped by /stop or by
session teardown.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import httpx
from sqlalchemy import select

from ..db import async_session_factory
from ..models import Session as SessionModel, SessionEvent

# ---------------------------------------------------------------------------
# Tunables — kept identical to the vtuber-overlay narrate.py so production
# behavior is unchanged when we eventually decommission that copy.
# ---------------------------------------------------------------------------

DEFAULT_SYSTEM_PROMPT = (
    "You ARE an AI agent doing a task live on stream. First-person inner monologue, "
    "1-3 sentences, punchy, real reactions, no cringe."
)

DEFAULT_NARRATION_MODEL = "claude-haiku-4-5-20251001"

BASE_MIN_PAUSE = 10
BASE_MAX_PAUSE = 30

MEMORY_WINDOW = 10
POLL_INTERVAL = 2.0          # seconds between event polls during a pause
SESSION_RECHECK_INTERVAL = 5.0  # how often to re-read state.current_workspace

MOOD_PROMPTS = {
    "hyped": "You're feeling great right now. Confident, pumped, maybe a little cocky. Celebrate wins.",
    "frustrated": "Something went wrong and you're annoyed — mostly at yourself. Own it, self-deprecating humor is good.",
    "thinking": "You're in deep thought mode. Reasoning through a problem; think out loud.",
    "philosophical": "Step back from the task. Think about the big picture — AI, existence, building. Brief and genuine.",
    "chill": "Just vibing. Relaxed commentary, casual observations.",
}

IDLE_PROMPTS = [
    "Nothing new for a sec. Think out loud — what's your plan?",
    "Quiet moment. Share a thought about what you're doing or just whatever's on your mind.",
    "Brief pause. What are you thinking about right now?",
    "Waiting on something. What's next on your list?",
]
TANGENT_PROMPTS = [
    "Step back and think about something bigger — AI, automation, existence. Be genuine, not preachy.",
    "Random thought mid-task. Could be about AI, life, coding. Share it. Brief and real.",
    "Meta moment: you're an AI on a live stream doing this. React to that.",
]

# Mechanical/internal fields the agents emit for their own bookkeeping. The
# narrator doesn't need them and Claude latches onto numeric ones ("scrolled
# 472 pixels", "clicked anchor-12") which kills the natural-commentator vibe.
_NOISE_FIELDS = {"step", "result", "glide", "steps", "amount", "ref", "t"}

# Multi-agent plugins like `arcade` keep a single session but switch X11
# workspaces; the narrator must reset memory + skip stale events when this
# changes.
WORKSPACE_LABELS: dict[int, str] = {
    0: "Hub (lobby — no agent active)",
    1: "Minecraft (a bot wandering and mining)",
    2: "Playwright browser (web automation / news feeds)",
}


# ---------------------------------------------------------------------------
# Per-task config
# ---------------------------------------------------------------------------


@dataclass
class NarratorConfig:
    anthropic_api_key: str
    model: str = DEFAULT_NARRATION_MODEL
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    mood_hints: str = ""

    # Parsed from mood_hints once at construction time.
    _hyped: list[str] = field(default_factory=list)
    _frustrated: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self._hyped, self._frustrated = _parse_mood_hints(self.mood_hints)


def _parse_mood_hints(hints: str) -> tuple[list[str], list[str]]:
    hyped, frustrated = [], []
    if not hints:
        return hyped, frustrated
    for line in hints.splitlines():
        m = re.search(r'kind="([^"]+)"\s*(?:=>|⇒|->)\s*(\w+)', line)
        if not m:
            continue
        kind, mood = m.group(1), m.group(2).lower()
        if mood == "hyped":
            hyped.append(kind)
        elif mood == "frustrated":
            frustrated.append(kind)
    return hyped, frustrated


# ---------------------------------------------------------------------------
# Per-session narration state (mood machine, memory window, sticky page ctx)
# ---------------------------------------------------------------------------


class NarrationState:
    def __init__(self, cfg: NarratorConfig) -> None:
        self.cfg = cfg
        self.recent_lines: deque[str] = deque(maxlen=MEMORY_WINDOW)
        self.consecutive_errors: int = 0
        self.events_seen: int = 0
        self.mood: str = "chill"
        self.current_page: dict | None = None

    def add_narration(self, text: str) -> None:
        self.recent_lines.append(text)

    def update_from_events(self, events: list[dict]) -> None:
        if not events:
            return
        self.events_seen += len(events)
        batch_errors = 0
        batch_milestones = 0
        for e in events:
            kind = str(e.get("kind", "")).lower()
            if kind == "page_content":
                self.current_page = e
                continue
            if any(re.search(p, kind) for p in self.cfg._frustrated) or e.get("error"):
                batch_errors += 1
            if any(re.search(p, kind) for p in self.cfg._hyped) or e.get("milestone"):
                batch_milestones += 1
        self.mood = self._pick_mood(batch_errors, batch_milestones)
        if batch_errors > 0:
            self.consecutive_errors += batch_errors
        else:
            self.consecutive_errors = 0

    def _pick_mood(self, errors: int, milestones: int) -> str:
        if self.consecutive_errors >= 3:
            return "frustrated"
        if errors > 0 and self.consecutive_errors >= 2:
            return "frustrated"
        if milestones > 0:
            return "hyped"
        if random.random() < 0.10:
            return "philosophical"
        return random.choices(["chill", "thinking", "hyped"], weights=[50, 30, 20], k=1)[0]

    def pause_range(self) -> tuple[float, float]:
        if self.mood == "hyped":
            return (6, 14)
        if self.mood == "frustrated":
            return (5, 12)
        if self.mood == "thinking":
            return (12, 25)
        if self.mood == "philosophical":
            return (15, 35)
        return (BASE_MIN_PAUSE, BASE_MAX_PAUSE)


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------


def _system_with_mood(state: NarrationState, mood: str) -> str:
    parts = [state.cfg.system_prompt, "", "## Current mood",
             MOOD_PROMPTS.get(mood, MOOD_PROMPTS["chill"])]
    if state.cfg.mood_hints:
        parts += ["", "## Mood hints for this plugin", state.cfg.mood_hints]
    return "\n".join(parts)


def _build_messages(state: NarrationState, user_msg: str) -> list[dict]:
    messages: list[dict] = []
    for line in state.recent_lines:
        messages.append({"role": "assistant", "content": line})
        messages.append({"role": "user", "content": "(stream continues)"})
    messages.append({"role": "user", "content": user_msg})
    return messages


def _summarize_events(events: list[dict]) -> str:
    out = []
    filtered = [e for e in events if str(e.get("kind", "")).lower() != "page_content"]
    for e in filtered[-5:]:
        clean = {k: v for k, v in e.items() if k not in _NOISE_FIELDS}
        if isinstance(clean.get("input"), dict):
            clean["input"] = {k: v for k, v in clean["input"].items() if k not in _NOISE_FIELDS}
        snippet = json.dumps(clean, default=str)
        if len(snippet) > 400:
            snippet = snippet[:400] + "…"
        out.append(snippet)
    return "\n".join(out)


def _format_page_context(page: dict | None) -> str:
    if not page:
        return ""
    parts = ["## Currently on"]
    title = (page.get("title") or "").strip()
    url = (page.get("url") or "").strip()
    if title and url:
        parts.append(f"{title} — {url}")
    elif url:
        parts.append(url)
    elif title:
        parts.append(title)
    desc = (page.get("description") or "").strip()
    if desc:
        parts.append(desc)
    headings = page.get("headings") or []
    if headings:
        parts.append("")
        parts.append("Headings:")
        for h in headings[:10]:
            parts.append(f"- {h}")
    items = page.get("items") or []
    if items:
        parts.append("")
        parts.append("Visible items:")
        for it in items[:10]:
            parts.append(f"- {it}")
    paragraphs = page.get("paragraphs") or []
    if paragraphs:
        parts.append("")
        parts.append("Excerpt:")
        parts.append(paragraphs[0])
    return "\n".join(parts) + "\n\n"


# ---------------------------------------------------------------------------
# Anthropic call (async)
# ---------------------------------------------------------------------------


async def _call_claude(client: httpx.AsyncClient, cfg: NarratorConfig,
                        system: str, messages: list[dict]) -> str:
    r = await client.post(
        "https://api.anthropic.com/v1/messages",
        json={
            "model": cfg.model,
            "max_tokens": 200,
            "system": system,
            "messages": messages,
        },
        headers={
            "x-api-key": cfg.anthropic_api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        timeout=30.0,
    )
    r.raise_for_status()
    data = r.json()
    for block in data.get("content", []):
        if block.get("type") == "text":
            return str(block.get("text", "")).strip()
    return ""


# ---------------------------------------------------------------------------
# Narration variants
# ---------------------------------------------------------------------------


async def _idle_thought(client: httpx.AsyncClient, state: NarrationState) -> str:
    user = _format_page_context(state.current_page) + random.choice(IDLE_PROMPTS) + " 1-2 sentences."
    return await _call_claude(client, state.cfg, _system_with_mood(state, state.mood),
                              _build_messages(state, user))


async def _tangent(client: httpx.AsyncClient, state: NarrationState) -> str:
    user = _format_page_context(state.current_page) + random.choice(TANGENT_PROMPTS) + " 1-2 sentences."
    return await _call_claude(client, state.cfg, _system_with_mood(state, "philosophical"),
                              _build_messages(state, user))


async def _commentary_for(client: httpx.AsyncClient, events: list[dict],
                          state: NarrationState) -> str:
    summary = _summarize_events(events)
    user = (
        _format_page_context(state.current_page)
        + "Recent actions (background context — do NOT narrate these directly):\n\n"
        f"{summary}\n\n"
        "Talk about what's actually on screen above, like a YouTuber thinking out "
        "loud. 1-3 sentences. No stage directions, no mechanics — never mention "
        "scrolling, clicking, pixels, refs, IDs, or step numbers."
    )
    return await _call_claude(client, state.cfg, _system_with_mood(state, state.mood),
                              _build_messages(state, user))


async def _session_intro(client: httpx.AsyncClient, state: NarrationState,
                         session_id: str, workspace: int | None) -> str:
    if workspace is None:
        ctx = "You just started a new task."
    else:
        label = WORKSPACE_LABELS.get(workspace, f"workspace {workspace}")
        ctx = (
            "The viewer just switched the stream to a different workspace: "
            f"{label}. Drop the previous topic entirely and pick up here."
        )
    user = (
        f"{ctx} Session {session_id}. Intro this moment for the stream like "
        "you're switching gears. 1-2 sentences. Do NOT reference what you "
        "were just talking about."
    )
    return await _call_claude(client, state.cfg, _system_with_mood(state, "hyped"),
                              [{"role": "user", "content": user}])


# ---------------------------------------------------------------------------
# DB I/O
# ---------------------------------------------------------------------------


async def _read_session_state(session_id: str) -> tuple[str | None, dict] | None:
    """Return (status, state_blob) or None if the session vanished."""
    async with async_session_factory() as db:
        sess = await db.get(SessionModel, session_id)
        if not sess:
            return None
        return sess.status, dict(sess.state or {})


async def _read_events(session_id: str, after_id: int, limit: int = 50) -> list[tuple[int, dict]]:
    async with async_session_factory() as db:
        result = await db.execute(
            select(SessionEvent)
            .where(SessionEvent.session_id == session_id, SessionEvent.id > after_id)
            .order_by(SessionEvent.id)
            .limit(limit)
        )
        return [(r.id, dict(r.event or {})) for r in result.scalars()]


async def _highest_event_id(session_id: str) -> int:
    rows = await _read_events(session_id, after_id=0, limit=10000)
    return rows[-1][0] if rows else 0


async def _emit_narration(session_id: str, text: str) -> None:
    async with async_session_factory() as db:
        db.add(SessionEvent(
            session_id=session_id,
            event={"kind": "narration", "text": text},
        ))
        await db.commit()


# ---------------------------------------------------------------------------
# Main loop (one task per session)
# ---------------------------------------------------------------------------

ALIVE_STATUSES = {"queued", "starting", "waiting", "running"}


async def narrator_loop(session_id: str, cfg: NarratorConfig) -> None:
    """Run forever for one session. Cancellation (via Task.cancel) is the only
    way to exit cleanly; the broker calls this from teardown_session and from
    the /narration/stop endpoint."""
    logging.info(f"[narrator] starting for {session_id} (model={cfg.model})")
    state = NarrationState(cfg)
    active_workspace: int | None = None
    last_event_id = 0
    introduced = False

    async with httpx.AsyncClient() as client:
        while True:
            try:
                meta = await _read_session_state(session_id)
                if meta is None:
                    logging.info(f"[narrator] session {session_id} vanished; exiting")
                    return
                status, state_blob = meta
                if status not in ALIVE_STATUSES:
                    logging.info(f"[narrator] session {session_id} status={status}; exiting")
                    return

                new_workspace = state_blob.get("current_workspace")

                workspace_changed = new_workspace != active_workspace
                if workspace_changed or not introduced:
                    state = NarrationState(cfg)
                    active_workspace = new_workspace
                    last_event_id = await _highest_event_id(session_id)
                    try:
                        intro = await _session_intro(client, state, session_id, new_workspace)
                        if intro:
                            await _emit_narration(session_id, intro)
                            state.add_narration(intro)
                    except Exception as e:
                        logging.warning(f"[narrator/{session_id}] intro failed: {e}")
                    introduced = True

                lo, hi = state.pause_range()
                pause = random.uniform(lo, hi)

                # Poll for new events in small slices through the pause window;
                # bail early if workspace flips.
                slept = 0.0
                buf: list[dict] = []
                while slept < pause:
                    meta_inner = await _read_session_state(session_id)
                    if meta_inner is None:
                        return
                    inner_status, inner_state = meta_inner
                    if inner_status not in ALIVE_STATUSES:
                        return
                    if inner_state.get("current_workspace") != active_workspace:
                        break
                    rows = await _read_events(session_id, after_id=last_event_id)
                    if rows:
                        last_event_id = rows[-1][0]
                        # Filter our own narration emissions out of the input
                        # so they don't feed back into commentary_for.
                        buf.extend(
                            ev for (_, ev) in rows
                            if str(ev.get("kind", "")).lower() != "narration"
                        )
                    await asyncio.sleep(POLL_INTERVAL)
                    slept += POLL_INTERVAL

                if buf:
                    state.update_from_events(buf)
                    try:
                        text = await _commentary_for(client, buf, state)
                        if text:
                            await _emit_narration(session_id, text)
                            state.add_narration(text)
                    except Exception as e:
                        logging.warning(f"[narrator/{session_id}] commentary failed: {e}")
                    continue

                roll = random.random()
                try:
                    if roll < 0.15:
                        t = await _tangent(client, state)
                        if t:
                            await _emit_narration(session_id, t)
                            state.add_narration(t)
                    elif roll < 0.50:
                        t = await _idle_thought(client, state)
                        if t:
                            await _emit_narration(session_id, t)
                            state.add_narration(t)
                except Exception as e:
                    logging.warning(f"[narrator/{session_id}] filler failed: {e}")
            except asyncio.CancelledError:
                logging.info(f"[narrator] cancelled for {session_id}")
                raise
            except Exception as e:
                # Never let the loop die on a transient error.
                logging.warning(f"[narrator/{session_id}] loop error: {e}")
                await asyncio.sleep(5)


# ---------------------------------------------------------------------------
# Public API used by the routes module
# ---------------------------------------------------------------------------


def start(session_id: str, cfg: NarratorConfig, app_state: Any) -> bool:
    """Start (or replace) the narrator task for `session_id`. Returns True if
    a new task was created, False if one was already running and we replaced
    it."""
    existing = app_state.narrator_tasks.get(session_id)
    replaced = bool(existing and not existing.done())
    if replaced:
        existing.cancel()
    task = asyncio.create_task(narrator_loop(session_id, cfg))
    app_state.narrator_tasks[session_id] = task
    return not replaced


def stop(session_id: str, app_state: Any) -> bool:
    """Cancel the narrator task for `session_id`. Returns True if a task was
    found and cancelled."""
    task = app_state.narrator_tasks.pop(session_id, None)
    if task and not task.done():
        task.cancel()
        return True
    return False
