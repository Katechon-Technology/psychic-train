// "Kat" agent: routes a voice transcript into a workspace switch + a short
// spoken reply. Mirrors katechon-demo/server.js:routeWithKatAgent. Uses
// server-side ANTHROPIC_API_KEY + ELEVENLABS_API_KEY so neither leaks to the
// browser.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL =
  process.env.DEMO_ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "jqcCZkN6Knx8BJ5TBdYR";
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2";

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
  action: "switch" | "unknown";
  workspace: string | null;
  speech: string;
};

function fallback(transcript: string): Decision {
  const t = transcript.toLowerCase();
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
    speech: "Try asking for SPECTRE, Minecraft, or the news feed.",
  };
}

async function routeWithClaude(transcript: string): Promise<Decision> {
  if (!ANTHROPIC_API_KEY) return fallback(transcript);
  const catalog = WORKSPACES.map((w) => `- ${w.id}: ${w.label}`).join("\n");
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
      system:
        "You are Kat, a snappy VTuber narrating what's on the user's livestream. " +
        "Pick exactly one panel to switch to based on the transcript and reply with one short spoken line. " +
        "If the transcript is unclear, set action=unknown and gently ask the user to pick a panel.\n\n" +
        `Available panels:\n${catalog}`,
      tools: [
        {
          name: "control_desktop",
          description: "Pick a workspace to switch to and what Kat should say.",
          input_schema: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["switch", "unknown"] },
              workspace: {
                type: "string",
                enum: WORKSPACES.map((w) => w.id),
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
  if (!r.ok) return fallback(transcript);
  const data = await r.json();
  const tool = (data.content || []).find(
    (b: { type: string; name?: string }) =>
      b.type === "tool_use" && b.name === "control_desktop",
  );
  if (!tool) return fallback(transcript);
  const input = tool.input as Partial<Decision>;
  const action = input.action === "switch" ? "switch" : "unknown";
  const workspace =
    input.workspace && WORKSPACES.some((w) => w.id === input.workspace)
      ? (input.workspace as string)
      : null;
  const speech = (input.speech || "").trim();
  if (!speech) return fallback(transcript);
  return { action, workspace, speech };
}

async function tts(text: string): Promise<string> {
  if (!ELEVENLABS_API_KEY) return "";
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
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
  let body: { transcript?: string };
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
  let decision: Decision;
  try {
    decision = await routeWithClaude(transcript);
  } catch {
    decision = fallback(transcript);
  }
  let audio = "";
  try {
    audio = await tts(decision.speech);
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
