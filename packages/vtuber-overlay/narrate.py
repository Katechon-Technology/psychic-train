#!/usr/bin/env python3
"""
psychic-train narrator sidecar.

Tails /var/log/session/agent.jsonl (written by the plugin's agent container) and
speaks first-person commentary via the Open-LLM-VTuber `/api/speak` endpoint.

Ported from claudetorio/packages/vtuber-stream-client/narrate.py. Kept:
  - mood system (chill / hyped / frustrated / thinking / philosophical)
  - pacing ranges per mood
  - 10-line memory window
  - idle + philosophical variation logic
  - speak() via POST /api/speak, has_viewers() via /api/speak/status

Changed:
  - Run discovery + step polling  →  JSONL tail on a local file
  - Hardcoded Factorio system prompt  →  NARRATION_SYSTEM_PROMPT env
  - Score-based mood triggers  →  JSONL-kind-based triggers from NARRATION_MOOD_HINTS
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
SPEAK_STATUS_URL = f"{AVATAR_URL}/api/speak/status"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
NARRATION_MODEL = os.environ.get("NARRATION_MODEL", "claude-haiku-4-5-20251001")

LOG_PATH = os.environ.get("NARRATION_LOG_PATH", "/var/log/session/agent.jsonl")

# Fallback prompt used only when NARRATION_SYSTEM_PROMPT is empty.
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
LOG_POLL_SECONDS = 0.2   # how often to check for new JSONL lines while narrating
WAIT_FOR_LOG_SECONDS = 120  # how long to wait for the log file to appear at startup

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
        self.milestones_hit: int = 0
        self.mood: str = "chill"
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
            if any(re.search(p, kind) for p in self._frustrated_triggers) or e.get("error"):
                batch_errors += 1
                self.total_errors += 1
            if any(re.search(p, kind) for p in self._hyped_triggers) or e.get("milestone"):
                batch_milestones += 1
        self.milestones_hit += batch_milestones

        if batch_errors > 0:
            self.consecutive_errors += batch_errors
        else:
            self.consecutive_errors = 0

        self.mood = self._pick_mood(batch_errors, batch_milestones)

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
    """Extract regex patterns from NARRATION_MOOD_HINTS lines like:
        kind="placed_entity" ⇒ hyped.
        kind="rcon_error"    ⇒ frustrated; own it.
    Simple best-effort parser; if parsing fails we just return empty lists and mood
    stays driven by built-in heuristics.
    """
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
# Avatar / Claude HTTP helpers (stdlib only)
# ---------------------------------------------------------------------------


def has_viewers() -> bool:
    try:
        req = urllib.request.Request(SPEAK_STATUS_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read()).get("clients", 0) > 0
    except Exception:
        return True  # fail open: narrate if status unknown


def speak(text: str) -> None:
    if not has_viewers():
        print(f'  [skip] no viewers: "{text[:60]}"')
        return
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
# Narration building blocks
# ---------------------------------------------------------------------------


def system_with_mood(mood: str) -> str:
    parts = [NARRATION_SYSTEM_PROMPT, "", f"## Current mood", MOOD_PROMPTS.get(mood, MOOD_PROMPTS["chill"])]
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


def _summarize_events(events: list[dict]) -> str:
    out = []
    for e in events[-5:]:  # cap to last 5 to keep prompt small
        snippet = json.dumps(e, default=str)
        if len(snippet) > 400:
            snippet = snippet[:400] + "…"
        out.append(snippet)
    return "\n".join(out)


def commentary_for(events: list[dict], state: NarrationState) -> str:
    summary = _summarize_events(events)
    user = (
        "Here's what just happened — these are YOUR actions logged as JSON:\n\n"
        f"{summary}\n\n"
        "React as yourself. 1-3 sentences max. No stage directions."
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
    user = random.choice(IDLE_PROMPTS) + " 1-2 sentences."
    return call_claude(system_with_mood(state.mood), build_messages(state, user))


def tangent(state: NarrationState) -> str:
    user = random.choice(TANGENT_PROMPTS) + " 1-2 sentences."
    return call_claude(system_with_mood("philosophical"), build_messages(state, user))


# ---------------------------------------------------------------------------
# JSONL tailer
# ---------------------------------------------------------------------------


def _wait_for_log() -> "file|None":
    """Block until the JSONL file exists (or give up). Returns an open file handle
    seeked to the end, or None on timeout."""
    deadline = time.monotonic() + WAIT_FOR_LOG_SECONDS
    while time.monotonic() < deadline:
        if os.path.exists(LOG_PATH):
            f = open(LOG_PATH, "r", encoding="utf-8", errors="replace")
            f.seek(0, 2)  # seek to end — we only care about new events
            return f
        time.sleep(1)
    print(f"  [warn] log {LOG_PATH} didn't appear in {WAIT_FOR_LOG_SECONDS}s", file=sys.stderr)
    return None


def _read_new_events(fh) -> list[dict]:
    """Read any newly-appended lines from the tailed file handle; return parsed JSON
    objects. Skips unparsable lines."""
    out: list[dict] = []
    while True:
        line = fh.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except Exception:
            # Tolerate garbage; include a synthetic event so the narrator can still
            # react to unknown content.
            out.append({"kind": "raw", "text": line[:500]})
    return out


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------


def run() -> None:
    print("=" * 50)
    print("  psychic-train narrator")
    print(f"  log:    {LOG_PATH}")
    print(f"  avatar: {AVATAR_URL}")
    print(f"  model:  {NARRATION_MODEL}")
    print("=" * 50)

    # Wait for the avatar server
    for i in range(60):
        try:
            with urllib.request.urlopen(f"{AVATAR_URL}/", timeout=5):
                break
        except Exception:
            if i == 59:
                print("  [warn] avatar server not responding; continuing anyway")
            time.sleep(1)

    fh = _wait_for_log()
    if fh is None:
        print("  exiting — no log file to tail")
        return

    state = NarrationState()
    print("  entering narration loop\n")

    # Short intro — fires even before the first event so viewers aren't in silence
    try:
        intro = call_claude(
            system_with_mood("hyped"),
            [{"role": "user", "content": "Intro yourself for the stream — you're live now. 1-2 sentences."}],
        )
        if intro:
            speak(intro)
            state.add_narration(intro)
    except Exception as e:
        print(f"  [warn] intro failed: {e}", file=sys.stderr)

    while True:
        lo, hi = state.pause_range()
        pause = random.uniform(lo, hi)
        print(f"  ... pausing {pause:.1f}s (mood: {state.mood})")

        # Sleep in small slices so we keep reading new JSONL lines as they arrive.
        slept = 0.0
        buf: list[dict] = []
        while slept < pause:
            buf.extend(_read_new_events(fh))
            time.sleep(LOG_POLL_SECONDS)
            slept += LOG_POLL_SECONDS

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

        # No events in this window — decide whether to fill silence
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
