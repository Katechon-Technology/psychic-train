// "Kat" agent: routes a voice transcript into a workspace switch + a short
// spoken reply. Mirrors katechon-demo/server.js:routeWithKatAgent. Uses
// server-side ANTHROPIC_API_KEY + ELEVENLABS_API_KEY so neither leaks to the
// browser. Per-request overrides (character/voice/persona) come from /demo's
// URL query params and let the same route be themed differently per visit.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL =
  process.env.DEMO_ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const DEFAULT_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "jqcCZkN6Knx8BJ5TBdYR";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2";

const DEFAULT_CHARACTER = "Kat";
// Ported almost verbatim from katechon-demo/server.js:247-251.
const DEFAULT_PERSONA =
  "You are Kat, the VTuber agent operating a remote Linux desktop for the viewer. " +
  "Route each transcript into exactly one control decision. Be snappy. " +
  "If the user asks for an app/panel/dashboard, choose that panel. If they ask to go back/home/main, choose the home action. " +
  "If the request is unclear, do not change panels. Always produce one short spoken line in Kat's voice.";

const WORKSPACES = [
  {
    id: "spectre",
    label: "OSINT / SPECTRE — open-source intelligence dashboards in a browser.",
  },
  {
    id: "minecraft",
    label: "Minecraft AI — bot wandering and mining in a Minecraft world.",
  },
  {
    id: "news",
    label: "AI News Feed — Playwright doomscrolling AI news sites.",
  },
];

type Decision = {
  action: "switch" | "home" | "unknown";
  workspace: string | null;
  speech: string;
};

type Overrides = {
  character?: string;
  voice?: string;
  persona?: string;
};

function fallback(transcript: string, character: string): Decision {
  const t = transcript.toLowerCase();
  if (/\b(home|main|menu|panel|back|return|landing)\b/.test(t)) {
    return { action: "home", workspace: null, speech: "Back to the main panel." };
  }
  if (/\b(minecraft|mine|craft|block)\b/.test(t)) {
    return { action: "switch", workspace: "minecraft", speech: "Hopping into Minecraft." };
  }
  if (/\b(news|feed|article|headline)\b/.test(t)) {
    return { action: "switch", workspace: "news", speech: "Pulling up the news feed." };
  }
  if (/\b(spectre|osint|intel|intelligence|dashboard)\b/.test(t)) {
    return { action: "switch", workspace: "spectre", speech: "Opening SPECTRE OSINT." };
  }
  return {
    action: "unknown",
    workspace: null,
    speech: `${character === "Kat" ? "Try" : `${character}: try`} asking for SPECTRE, Minecraft, or the news feed.`,
  };
}

function buildSystemPrompt(character: string, persona: string): string {
  const catalog = WORKSPACES.map((w) => `- ${w.id}: ${w.label}`).join("\n");
  return (
    `${persona}\n\n` +
    `You speak as: ${character}.\n\n` +
    `Available panels:\n${catalog}`
  );
}

async function routeWithClaude(
  transcript: string,
  character: string,
  persona: string,
): Promise<Decision> {
  if (!ANTHROPIC_API_KEY) return fallback(transcript, character);
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 240,
      system: buildSystemPrompt(character, persona),
      tools: [
        {
          name: "control_desktop",
          description:
            "Pick a workspace to switch to (or go home), and what to say.",
          input_schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["switch", "home", "unknown"] },
              workspace: {
                type: "string",
                enum: WORKSPACES.map((w) => w.id),
                description: "Required when action=switch.",
              },
              speech: {
                type: "string",
                description: "One short spoken reply, under 14 words. No markdown.",
              },
            },
            required: ["action", "speech"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "control_desktop" },
      messages: [{ role: "user", content: transcript }],
    }),
  });
  if (!r.ok) return fallback(transcript, character);
  const data = await r.json();
  const tool = (data.content || []).find(
    (b: { type: string; name?: string }) =>
      b.type === "tool_use" && b.name === "control_desktop",
  );
  if (!tool) return fallback(transcript, character);
  const input = tool.input as Partial<Decision>;
  let action: Decision["action"];
  if (input.action === "switch") action = "switch";
  else if (input.action === "home") action = "home";
  else action = "unknown";
  const workspace =
    action === "switch" &&
    input.workspace &&
    WORKSPACES.some((w) => w.id === input.workspace)
      ? (input.workspace as string)
      : null;
  const speech = (input.speech || "").trim();
  if (!speech) return fallback(transcript, character);
  return { action, workspace, speech };
}

async function tts(text: string, voiceId: string): Promise<string> {
  if (!ELEVENLABS_API_KEY) return "";
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVENLABS_MODEL_ID,
        output_format: "mp3_44100_128",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    },
  );
  if (!r.ok) return "";
  return Buffer.from(await r.arrayBuffer()).toString("base64");
}

export async function POST(req: Request) {
  let body: { transcript?: string } & Overrides;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const transcript = String(body.transcript || "").trim();
  if (!transcript) {
    return new Response(JSON.stringify({ error: "empty transcript" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const character = (body.character || DEFAULT_CHARACTER).slice(0, 64);
  const voice = (body.voice || DEFAULT_VOICE_ID).slice(0, 64);
  const persona = (body.persona || DEFAULT_PERSONA).slice(0, 2000);

  let decision: Decision;
  try {
    decision = await routeWithClaude(transcript, character, persona);
  } catch {
    decision = fallback(transcript, character);
  }
  let audio = "";
  try {
    audio = await tts(decision.speech, voice);
  } catch {
    /* keep audio empty; client still shows toast */
  }
  return new Response(
    JSON.stringify({
      action: decision.action,
      workspace: decision.workspace,
      speech: decision.speech,
      audio,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
