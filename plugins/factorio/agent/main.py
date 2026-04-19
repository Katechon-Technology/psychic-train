"""Factorio plugin agent — v1 stub.

Connects to the Factorio server over RCON and issues periodic Lua commands based on
Claude's instructions. This is a minimal loop intended to prove the plugin wiring;
for the full observe-think-act agent (with FLE, gym.Env, VCS directives), port
`../../../../claudetorio/packages/run-worker/main.py` and the `packages/fle/` library
into this image.
"""

import json
import os
import sys
import time

from factorio_rcon import RCONClient
from anthropic import Anthropic


SESSION_ID = os.environ["SESSION_ID"]
BROKER_URL = os.environ["BROKER_URL"]
ENV_HOST = os.environ["ENV_HOST"]
RCON_PORT = int(os.environ["RCON_PORT"])
RCON_PASSWORD = os.environ["RCON_PASSWORD"]
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = os.environ.get("MODEL", "claude-sonnet-4-5-20250929")

# Shared-volume JSONL log the narrator (vtuber-overlay) tails. Safe no-op when the
# directory isn't mounted (narration disabled for this kind).
LOG_PATH = os.environ.get("SESSION_LOG_PATH", "/var/log/session/agent.jsonl")


def log(kind: str, **fields) -> None:
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": time.time(), "kind": kind, **fields}, default=str) + "\n")
    except Exception:
        pass

SYSTEM_PROMPT = (
    "You are playing Factorio through RCON. Each turn, reply with a short Lua snippet "
    "to run via /sc (server command). Keep it simple: move the player, craft an item, "
    "mine a tree. Reply with ONLY the Lua code, no explanation, no markdown fences."
)


def connect_rcon_with_warmup(host: str, port: int, password: str) -> RCONClient:
    # Dismiss the "achievements disabled" warning (first /sc is swallowed)
    warmup = RCONClient(host, port, password)
    warmup.send_command("/sc rcon.print('warmup')")
    warmup.send_command("/sc rcon.print('warmup')")
    warmup.close()
    return RCONClient(host, port, password)


def main() -> None:
    log("session_start", session_id=SESSION_ID, env_host=ENV_HOST, rcon_port=RCON_PORT)
    print(f"[agent] session={SESSION_ID} connecting RCON {ENV_HOST}:{RCON_PORT}", flush=True)
    rcon: RCONClient | None = None
    for attempt in range(60):
        try:
            rcon = connect_rcon_with_warmup(ENV_HOST, RCON_PORT, RCON_PASSWORD)
            break
        except Exception as e:
            print(f"[agent] rcon attempt {attempt}: {e}", flush=True)
            time.sleep(3)
    if rcon is None:
        log("rcon_error", text="could not connect after 60 attempts")
        print("[agent] could not connect to RCON", file=sys.stderr)
        sys.exit(1)
    log("rcon_connected", host=ENV_HOST, port=RCON_PORT)

    claude = Anthropic(api_key=ANTHROPIC_API_KEY)
    history: list[dict] = []

    for step in range(200):
        msg = claude.messages.create(
            model=MODEL,
            max_tokens=256,
            system=SYSTEM_PROMPT,
            messages=history or [{"role": "user", "content": "You just joined a fresh Factorio server. Start the game."}],
        )
        code = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        code = code.strip("`").strip()
        if code.startswith("lua"):
            code = code[3:].lstrip()

        try:
            result = rcon.send_command(f"/sc rcon.print(tostring(({code}) or 'ok'))")
            log("rcon_step", step=step, code=code[:500], result=(str(result) or "")[:500])
            print(f"[agent] step {step}: {code!r} -> {result!r}", flush=True)
        except Exception as e:
            result = f"error: {e}"
            log("rcon_error", step=step, code=code[:500], text=str(e)[:500])
            print(f"[agent] step {step}: {code!r} -> {result}", flush=True)

        history.append({"role": "assistant", "content": code})
        history.append({"role": "user", "content": f"Result: {result}"})
        history = history[-12:]
        time.sleep(6)

    log("session_end", reason="max_steps")


if __name__ == "__main__":
    main()
