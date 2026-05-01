// Forwards the audio body to Groq's Whisper-compatible endpoint and returns
// {text}. Uses GROQ_API_KEY from server env so it never reaches the browser.
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3";

export async function POST(req: Request) {
  if (!GROQ_API_KEY) {
    return new Response(
      JSON.stringify({ error: "GROQ_API_KEY is not configured" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const ct = (req.headers.get("content-type") || "audio/webm").split(";")[0].trim();
  const ext = ct.includes("ogg") ? "ogg" : ct.includes("mp4") ? "mp4" : "webm";
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.byteLength === 0) {
    return new Response(JSON.stringify({ error: "no audio data" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: ct }), `audio.${ext}`);
  form.append("model", GROQ_MODEL);
  form.append("language", "en");
  form.append("response_format", "verbose_json");

  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = data.error?.message || data.error || r.statusText;
    return new Response(JSON.stringify({ error: message }), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ text: data.text || "" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
