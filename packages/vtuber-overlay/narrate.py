#!/usr/bin/env python3
"""
psychic-train narrator sidecar — persistent variant.

Runs forever inside the persistent vtuber-overlay container. Polls
GET /api/stream/current-source to know which session is currently flagged
livestream_status="on". When the active session changes, resets memory and
fast-forwards past the backlog so we only narrate events going forward.
When no session is live, falls quiet (Phase 1: no replay narration).
"""

import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from collections import deque

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

AVATAR_URL = os.environ.get("AVATAR_URL", "http://localhost:12393")
SPEAK_URL = f"{AVATAR_URL}/api/speak"

BROKER_URL = os.environ.get("BROKER_URL", "http://broker:8080")
CURRENT_SOURCE_URL = f"{BROKER_URL.rstrip('/')}/api/stream/current-source"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
NARRATION_MODEL = os.environ.get("NARRATION_MODEL", "claude-haiku-4-5-20251001")

DEFAULT_SYSTEM_PROMPT = (
    "You ARE an AI agent doing a task live on stream. First-person inner monologue, "
    "1-3 sentences, punchy, real reactions, no cringe."
)
NARRATION_SYSTEM_PROMPT = (
    os.environ.get("NARRATION_SYSTEM_PROMPT") or DEFAULT_SYSTEM_PROMPT
).strip()
NARRATION_MOOD_HINTS = os.environ.get("NARRATION_MOOD_HINTS", "").strip()

BASE_MIN_PAUSE = int(os.environ.get("MIN_PAUSE", "10"))
BASE_MAX_PAUSE = int(os.environ.get("MAX_PAUSE", "30"))

MEMORY_WINDOW = 10
POLL_INTERVAL = 2.0          # seconds between event polls during a pause
SOURCE_POLL_INTERVAL = 5.0   # how often to recheck which session is active

MOOD_PROMPTS = {
    "hyped": "You're feeling great right now. Confident, pumped, maybe a little cocky. Celebrate wins.",
    "frustrated": "Something went wrong and you're annoyed — mostly at yourself. Own it, self-deprecating humor is good.",
    "thinking": "You're in deep thought mode. Reasoning through a problem; think out loud.",
    "philosophical": "Step back from the task. Think about the big picture — AI, existence, building. Brief and genuine.",
    "chill": "Just vibing. Relaxed commentary, casual observations.",
}

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------


class NarrationState:
    def __init__(self) -> None:
        self.recent_lines: deque[str] = deque(maxlen=MEMORY_WINDOW)
        self.consecutive_errors: int = 0
        self.total_errors: int = 0
        self.events_seen: int = 0
        self.mood: str = "chill"
        # Latest page_content event payload, kept sticky between events so the
        # narrator always has on-screen context to react to. Reset on session
        # switch by virtue of NarrationState() being reconstructed.
        self.current_page: dict | None = None
        self._hyped_triggers, self._frustrated_triggers = _parse_mood_hints(NARRATION_MOOD_HINTS)

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
            if any(re.search(p, kind) for p in self._frustrated_triggers) or e.get("error"):
                batch_errors += 1
                self.total_errors += 1
            if any(re.search(p, kind) for p in self._hyped_triggers) or e.get("milestone"):
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
# Broker polling
# ---------------------------------------------------------------------------


def get_active_session_id() -> str | None:
    """Return the session_id currently flagged livestream_status='on', or
    None when nothing is live (broker returns type='none' or 'archive')."""
    try:
        with urllib.request.urlopen(CURRENT_SOURCE_URL, timeout=10) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"  [warn] current-source poll failed: {e}", file=sys.stderr)
        return None
    if data.get("type") == "live":
        return data.get("session_id")
    return None


# Multi-agent plugins like `arcade` keep a single session but switch X11
# workspaces; the narrator must reset memory + skip stale events when this
# changes, otherwise the avatar keeps talking about the previous workspace.
WORKSPACE_LABELS: dict[int, str] = {
    0: "Hub (lobby — no agent active)",
    1: "Minecraft (a bot wandering and mining)",
    2: "Playwright browser (web automation / news feeds)",
}


def get_current_workspace(session_id: str) -> int | None:
    try:
        with urllib.request.urlopen(
            f"{BROKER_URL.rstrip('/')}/api/sessions/{session_id}", timeout=10
        ) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"  [warn] session fetch failed: {e}", file=sys.stderr)
        return None
    return (data.get("state") or {}).get("current_workspace")


def fetch_events(session_id: str, after_id: int, limit: int = 50) -> list[dict]:
    url = f"{BROKER_URL.rstrip('/')}/api/sessions/{session_id}/events?after={after_id}&limit={limit}"
    try:
        with urllib.request.urlopen(url, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  [warn] fetch_events failed: {e}", file=sys.stderr)
        return []


def fast_forward_event_id(session_id: str) -> int:
    """When switching to a session, skip past any backlog so we only narrate
    events going forward. Returns the highest event id currently in the
    session's log (0 if none)."""
    rows = fetch_events(session_id, after_id=0, limit=10000)
    if not rows:
        return 0
    return rows[-1]["id"]


# ---------------------------------------------------------------------------
# Avatar / Claude HTTP helpers
# ---------------------------------------------------------------------------


def speak(text: str) -> None:
    try:
        payload = json.dumps({"text": text}).encode()
        req = urllib.request.Request(SPEAK_URL, data=payload,
                                      headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read())
        print(f'  [speak] "{text}" ({out.get("clients", 0)} client(s))')
    except Exception as e:
        print(f"  [warn] speak failed: {e}", file=sys.stderr)


def call_claude(system: str, messages: list[dict]) -> str:
    payload = json.dumps({
        "model": NARRATION_MODEL,
        "max_tokens": 200,
        "system": system,
        "messages": messages,
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    for block in data.get("content", []):
        if block.get("type") == "text":
            return block["text"].strip()
    return ""


# ---------------------------------------------------------------------------
# Narration helpers
# ---------------------------------------------------------------------------


def system_with_mood(mood: str) -> str:
    parts = [NARRATION_SYSTEM_PROMPT, "", "## Current mood", MOOD_PROMPTS.get(mood, MOOD_PROMPTS["chill"])]
    if NARRATION_MOOD_HINTS:
        parts += ["", "## Mood hints for this plugin", NARRATION_MOOD_HINTS]
    return "\n".join(parts)


def build_messages(state: NarrationState, user_msg: str) -> list[dict]:
    messages: list[dict] = []
    for line in state.recent_lines:
        messages.append({"role": "assistant", "content": line})
        messages.append({"role": "user", "content": "(stream continues)"})
    messages.append({"role": "user", "content": user_msg})
    return messages


# Mechanical/internal fields the agents emit for their own bookkeeping. The
# narrator doesn't need them and Claude latches onto numeric ones ("scrolled
# 472 pixels", "clicked anchor-12") which kills the natural-commentator vibe.
_NOISE_FIELDS = {"step", "result", "glide", "steps", "amount", "ref", "t"}


def _summarize_events(events: list[dict]) -> str:
    out = []
    # page_content events are handled separately as sticky context — keep them
    # out of the JSON tail so they don't blow the token budget.
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


def commentary_for(events: list[dict], state: NarrationState) -> str:
    summary = _summarize_events(events)
    user = (
        _format_page_context(state.current_page)
        + "Recent actions (background context — do NOT narrate these directly):\n\n"
        f"{summary}\n\n"
        "Talk about what's actually on screen above, like a YouTuber thinking out "
        "loud. 1-3 sentences. No stage directions, no mechanics — never mention "
        "scrolling, clicking, pixels, refs, IDs, or step numbers."
    )
    return call_claude(system_with_mood(state.mood), build_messages(state, user))


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


def idle_thought(state: NarrationState) -> str:
    user = _format_page_context(state.current_page) + random.choice(IDLE_PROMPTS) + " 1-2 sentences."
    return call_claude(system_with_mood(state.mood), build_messages(state, user))


def tangent(state: NarrationState) -> str:
    user = _format_page_context(state.current_page) + random.choice(TANGENT_PROMPTS) + " 1-2 sentences."
    return call_claude(system_with_mood("philosophical"), build_messages(state, user))


def session_intro(
    state: NarrationState, session_id: str, workspace: int | None = None
) -> str:
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
    return call_claude(system_with_mood("hyped"), [{"role": "user", "content": user}])


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run() -> None:
    print("=" * 50)
    print("  psychic-train narrator (persistent)")
    print(f"  broker:  {BROKER_URL}")
    print(f"  avatar:  {AVATAR_URL}")
    print(f"  model:   {NARRATION_MODEL}")
    print("=" * 50)

    # Wait for avatar server
    for i in range(60):
        try:
            with urllib.request.urlopen(f"{AVATAR_URL}/", timeout=5):
                break
        except Exception:
            if i == 59:
                print("  [warn] avatar server not responding; continuing anyway")
            time.sleep(1)

    state = NarrationState()
    active_session_id: str | None = None
    active_workspace: int | None = None
    last_event_id: int = 0
    print("  entering narration loop\n")

    while True:
        # Re-check which session (if any) is currently being streamed AND
        # which workspace within that session (multi-agent plugins like
        # `arcade` keep one session but flip workspaces — narrator must
        # reset memory + skip stale events on workspace flip too).
        new_active = get_active_session_id()
        new_workspace = (
            get_current_workspace(new_active) if new_active else None
        )

        session_changed = new_active != active_session_id
        workspace_changed = (
            new_active is not None
            and new_workspace != active_workspace
        )

        if session_changed or workspace_changed:
            print(
                f"  [switch] session: {active_session_id} -> {new_active}, "
                f"workspace: {active_workspace} -> {new_workspace}"
            )
            state = NarrationState()
            active_session_id = new_active
            active_workspace = new_workspace
            if new_active is None:
                last_event_id = 0
            else:
                last_event_id = fast_forward_event_id(new_active)
                try:
                    intro = session_intro(state, new_active, new_workspace)
                    if intro:
                        speak(intro)
                        state.add_narration(intro)
                except Exception as e:
                    print(f"  [warn] intro failed: {e}", file=sys.stderr)

        if active_session_id is None:
            # Standby — Phase 1 stays quiet during archive replay / no source.
            time.sleep(SOURCE_POLL_INTERVAL)
            continue

        lo, hi = state.pause_range()
        pause = random.uniform(lo, hi)
        print(f"  ... pausing {pause:.1f}s (session={active_session_id} mood={state.mood})")

        # Poll for new events in small slices throughout the pause window.
        slept = 0.0
        buf: list[dict] = []
        while slept < pause:
            # Bail out early if the active session OR workspace changed.
            cur_active = get_active_session_id()
            if cur_active != active_session_id:
                break
            if cur_active is not None and get_current_workspace(cur_active) != active_workspace:
                break
            rows = fetch_events(active_session_id, after_id=last_event_id)
            if rows:
                last_event_id = rows[-1]["id"]
                buf.extend(r["event"] for r in rows)
            time.sleep(POLL_INTERVAL)
            slept += POLL_INTERVAL

        if buf:
            state.update_from_events(buf)
            print(f"  {len(buf)} new event(s); mood={state.mood}")
            try:
                text = commentary_for(buf, state)
                if text:
                    speak(text)
                    state.add_narration(text)
            except Exception as e:
                print(f"  [warn] commentary failed: {e}", file=sys.stderr)
            continue

        roll = random.random()
        try:
            if roll < 0.15:
                print("  [tangent]")
                t = tangent(state)
                if t:
                    speak(t)
                    state.add_narration(t)
            elif roll < 0.50:
                print("  [idle]")
                t = idle_thought(state)
                if t:
                    speak(t)
                    state.add_narration(t)
            else:
                print("  [quiet]")
        except Exception as e:
            print(f"  [warn] filler failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        pass
