import mineflayer from "mineflayer";
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const {
  ENV_HOST,
  GAME_PORT = "25565",
  ANTHROPIC_API_KEY,
  MODEL = "claude-sonnet-4-5-20250929",
  USERNAME = "ClaudeBot",
  VIEWER_USERNAME = "Spectator",
  SESSION_ID = "unknown",
  SESSION_LOG_PATH = "/var/log/session/agent.jsonl",
} = process.env;

if (!ENV_HOST || !ANTHROPIC_API_KEY) {
  console.error("[agent] ENV_HOST and ANTHROPIC_API_KEY are required");
  process.exit(1);
}

function log(kind, fields = {}) {
  try {
    mkdirSync(dirname(SESSION_LOG_PATH), { recursive: true });
    appendFileSync(
      SESSION_LOG_PATH,
      JSON.stringify({ t: Date.now() / 1000, kind, ...fields }) + "\n",
    );
  } catch {
    // ignore
  }
}

function createBot() {
  console.log(`[agent] session=${SESSION_ID} connecting to ${ENV_HOST}:${GAME_PORT}`);
  const bot = mineflayer.createBot({
    host: ENV_HOST,
    port: Number(GAME_PORT),
    username: USERNAME,
    auth: "offline",
  });

  bot.on("error", (e) => console.error("[agent] bot error:", e.message));
  bot.on("kicked", (r) => console.warn("[agent] kicked:", r));
  bot.on("end", () => {
    console.log("[agent] disconnected; reconnecting in 5s");
    setTimeout(createBot, 5000);
  });

  const claude = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  function stateSnapshot() {
    if (!bot.entity) return "uninitialized";
    const p = bot.entity.position;
    const yaw = bot.entity.yaw.toFixed(2);
    const health = bot.health;
    const nearby = Object.values(bot.entities)
      .filter((e) => e !== bot.entity && e.position.distanceTo(p) < 20)
      .slice(0, 5)
      .map((e) => `${e.name ?? e.displayName ?? "entity"}@${e.position.x.toFixed(0)},${e.position.y.toFixed(0)},${e.position.z.toFixed(0)}`)
      .join("; ");
    return `pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} yaw=${yaw} hp=${health} nearby=[${nearby}]`;
  }

  const tools = [
    {
      name: "chat",
      description: "Say something in chat or run a slash command like /time set day.",
      input_schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    },
    {
      name: "look",
      description: "Set view direction. yaw in radians (0=south), pitch -PI/2..PI/2.",
      input_schema: { type: "object", properties: { yaw: { type: "number" }, pitch: { type: "number" } }, required: ["yaw", "pitch"] },
    },
    {
      name: "move",
      description: "Set movement controls for `duration_ms` then stop.",
      input_schema: {
        type: "object",
        properties: {
          forward: { type: "boolean" },
          back: { type: "boolean" },
          left: { type: "boolean" },
          right: { type: "boolean" },
          jump: { type: "boolean" },
          sprint: { type: "boolean" },
          duration_ms: { type: "number" },
        },
        required: ["duration_ms"],
      },
    },
    {
      name: "wait",
      description: "Idle for N seconds so the stream viewer can see.",
      input_schema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] },
    },
  ];

  async function runTool(tool, input) {
    switch (tool) {
      case "chat":
        bot.chat(input.message);
        return "sent";
      case "look":
        await bot.look(input.yaw, input.pitch, false);
        return "ok";
      case "move": {
        const controls = ["forward", "back", "left", "right", "jump", "sprint"];
        for (const c of controls) if (c in input) bot.setControlState(c, !!input[c]);
        await new Promise((r) => setTimeout(r, Math.min(15000, Number(input.duration_ms) || 500)));
        for (const c of controls) bot.setControlState(c, false);
        return "moved";
      }
      case "wait":
        await new Promise((r) => setTimeout(r, Math.min(60, Number(input.seconds) || 1) * 1000));
        return `waited ${input.seconds}s`;
      default:
        return `unknown tool: ${tool}`;
    }
  }

  bot.once("spawn", async () => {
    console.log("[agent] spawned; waiting 4s for chunks");
    log("session_start", { session_id: SESSION_ID, host: ENV_HOST, port: GAME_PORT });
    await new Promise((r) => setTimeout(r, 4000));

    // Keep the Spectator stream-client locked onto ClaudeBot.
    // Requires ClaudeBot to be an operator on the server.
    const spectatorInterval = setInterval(() => {
      if (bot.players[VIEWER_USERNAME]) {
        bot.chat(`/gamemode spectator ${VIEWER_USERNAME}`);
        bot.chat(`/execute as ${VIEWER_USERNAME} run spectate ${USERNAME}`);
      }
    }, 8000);
    bot.once("end", () => clearInterval(spectatorInterval));

    const systemPrompt =
      "You control a mineflayer bot in Minecraft creative mode. Each turn, examine the state and call ONE tool. Explore, build, interact — keep it interesting for a live stream viewer. Never stop exploring.";

    const seed = {
      role: "user",
      content:
        "You are a Minecraft bot in creative mode. Explore your surroundings, interact with the world, and entertain a viewer. Start by looking around, then move to somewhere interesting. Call one tool per turn.",
    };
    let messages = [seed];
    let step = 0;

    while (true) {
      step++;
      messages.push({ role: "user", content: `State: ${stateSnapshot()}` });

      // Trim history every 10 steps. Always start the kept slice on a
      // non-tool_result user turn so there are no orphaned tool_result blocks.
      if (step % 10 === 0 && messages.length > 22) {
        let kept = messages.slice(-20);
        while (kept.length > 0) {
          const first = kept[0];
          if (first.role === "user" && Array.isArray(first.content) &&
              first.content[0]?.type === "tool_result") {
            kept = kept.slice(2); // drop the orphaned tool_result + its assistant pair
          } else {
            break;
          }
        }
        messages = [seed, ...kept];
      }

      let res;
      try {
        res = await claude.messages.create({
          model: MODEL,
          max_tokens: 512,
          system: systemPrompt,
          messages,
          tools,
        });
      } catch (err) {
        console.error("[agent] claude error:", err.message);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      messages.push({ role: "assistant", content: res.content });

      const toolUses = res.content.filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) {
        console.log("[agent] no tool calls; idling 5s then continuing");
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }

      const results = [];
      for (const tu of toolUses) {
        const out = await runTool(tu.name, tu.input);
        console.log(`[agent] step=${step} ${tu.name}(${JSON.stringify(tu.input)}) -> ${out}`);
        log(tu.name, { step, input: tu.input, result: out });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }
  });
}

log("session_start", { session_id: SESSION_ID });
createBot();
