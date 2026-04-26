// playwright-browser plugin agent — infinite news doomscroll.
//
// Loop: pick a random no-paywall news site, then run a hotspot tour — extract
// Y positions of headline-shaped anchors on the page, shuffle, and visit each
// in turn with a small multi-step glide and an 8-18s dwell so the stream
// lingers on actual content. Occasionally click into the hotspot we're on,
// dwell on the article, return to the feed, re-extract hotspots, repeat.
// After ~5 minutes (or earlier if scrollY hasn't moved for STUCK_TIMEOUT_MS,
// or if the site has no qualifying hotspots and the slow-scroll fallback
// also stalls), rotate to a different site. Runs until the container is
// killed (session TTL).
//
// We POST kind:"tool" events to the broker for every navigate/scroll/click so
// the vtuber-overlay narrator (separate Claude in packages/vtuber-overlay) has
// material to react to. The agent itself does not call Claude.

const {
  ENV_HOST,
  API_PORT,
  SESSION_ID = "unknown",
  BROKER_URL = "http://broker:8080",
  BROKER_API_KEY = "",
} = process.env;

if (!ENV_HOST || !API_PORT) {
  console.error("missing ENV_HOST / API_PORT");
  process.exit(1);
}

const BASE = `http://${ENV_HOST}:${API_PORT}`;

const SITES = [
  { name: "hackernews", url: "https://news.ycombinator.com/" },
  { name: "lobsters", url: "https://lobste.rs/" },
  { name: "techmeme", url: "https://www.techmeme.com/" },
  { name: "memeorandum", url: "https://www.memeorandum.com/" },
  { name: "drudge", url: "https://www.drudgereport.com/" },
  { name: "dailymail", url: "https://www.dailymail.co.uk/home/index.html" },
  { name: "nypost", url: "https://nypost.com/" },
  { name: "thesun", url: "https://www.thesun.co.uk/" },
  { name: "bbc", url: "https://www.bbc.com/news" },
  { name: "guardian", url: "https://www.theguardian.com/international" },
  { name: "apnews", url: "https://apnews.com/" },
  { name: "aljazeera", url: "https://www.aljazeera.com/news/" },
  { name: "reddit", url: "https://old.reddit.com/r/worldnews/" },
];

const DWELL_MS = 5 * 60_000;
const SCROLL_MIN_MS = 3_000;
const SCROLL_MAX_MS = 8_000;
const CLICK_MIN_MS = 30_000;
const CLICK_MAX_MS = 60_000;
const ARTICLE_DWELL_MIN_MS = 20_000;
const ARTICLE_DWELL_MAX_MS = 40_000;
// If scrollY hasn't moved for this long, the page is stuck (paywall, modal,
// hung load, end of feed, etc). Bail and rotate to another site.
const STUCK_TIMEOUT_MS = 40_000;
// Hotspot tour parameters: visit shuffled headline-shaped anchors, glide
// between them in small steps, and linger on each so the stream actually
// shows content rather than blowing past it.
const HOTSPOT_DWELL_MIN_MS = 8_000;
const HOTSPOT_DWELL_MAX_MS = 18_000;
const GLIDE_STEPS_MIN = 2;
const GLIDE_STEPS_MAX = 4;
const GLIDE_STEP_PAUSE_MIN_MS = 250;
const GLIDE_STEP_PAUSE_MAX_MS = 600;
const REVERSE_GLIDE_PROBABILITY = 0.25;
const REVERSE_GLIDE_PX_MIN = 80;
const REVERSE_GLIDE_PX_MAX = 200;

function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(kind: string, fields: Record<string, unknown> = {}): void {
  const event = { t: Date.now() / 1000, kind, ...fields };
  fetch(`${BROKER_URL}/api/sessions/${SESSION_ID}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(BROKER_API_KEY ? { Authorization: `Bearer ${BROKER_API_KEY}` } : {}),
    },
    body: JSON.stringify(event),
  }).catch(() => {});
}

type ToolResult = { ok: boolean; data?: any; error?: string };

async function pwCall(path: string, body: unknown = {}): Promise<ToolResult> {
  try {
    const r = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : null;
    if (!r.ok) return { ok: false, error: `${r.status} ${JSON.stringify(data)}` };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function createSession(): Promise<string> {
  const r = await fetch(`${BASE}/session`, { method: "POST" });
  const body = await r.json();
  return body.id;
}

interface SnapshotElement {
  ref: string;
  role: string;
  name?: string;
  tag: string;
  href?: string;
}

interface SnapshotResult {
  url: string;
  title: string;
  elements: SnapshotElement[];
}

async function navigateTo(sid: string, url: string, step: number): Promise<void> {
  const res = await pwCall(`/session/${sid}/navigate`, { url });
  console.log(`[agent] step=${step} tool=navigate url=${url} -> ${res.ok ? "ok" : res.error}`);
  log("tool", {
    step,
    name: "navigate",
    input: { url },
    result: res.ok ? JSON.stringify(res.data).slice(0, 500) : undefined,
    error: res.ok ? undefined : res.error,
  });
}

async function scrollDown(sid: string, step: number): Promise<void> {
  const res = await pwCall(`/session/${sid}/scroll`, { direction: "down" });
  log("tool", {
    step,
    name: "scroll",
    input: { direction: "down" },
    error: res.ok ? undefined : res.error,
  });
}

async function snapshot(sid: string): Promise<SnapshotResult | null> {
  const res = await pwCall(`/session/${sid}/snapshot`);
  return res.ok ? (res.data as SnapshotResult) : null;
}

async function getScrollY(sid: string): Promise<number> {
  const res = await pwCall(`/session/${sid}/evaluate`, {
    expression: "return window.scrollY;",
  });
  if (!res.ok) return 0;
  const y = Number(res.data?.result);
  return Number.isFinite(y) ? y : 0;
}

interface Hotspot {
  y: number;
  ref: string | null;
  text: string;
}

// Walks the DOM and returns absolute Y positions of headline-shaped anchors,
// de-duped to one per ~40px row so a stack of stub-links doesn't dominate.
// Reads `data-ai-ref` set by an earlier snapshot so we can click the same
// element later without taking a fresh snapshot (which would invalidate refs).
const HOTSPOT_EXTRACT_JS = `
  const out = [];
  const buckets = new Set();
  for (const el of document.querySelectorAll('a[href]')) {
    const r = el.getBoundingClientRect();
    if (r.height < 8) continue;
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ');
    if (text.length < 20 || text.length > 200) continue;
    const y = Math.round(r.top + window.scrollY);
    const bucket = Math.floor(y / 40);
    if (buckets.has(bucket)) continue;
    buckets.add(bucket);
    out.push({ y: y, ref: el.getAttribute('data-ai-ref'), text: text.slice(0, 100) });
  }
  out.sort((a, b) => a.y - b.y);
  return out;
`;

async function extractHotspots(sid: string): Promise<Hotspot[]> {
  const res = await pwCall(`/session/${sid}/evaluate`, { expression: HOTSPOT_EXTRACT_JS });
  if (!res.ok) return [];
  const data = res.data?.result;
  return Array.isArray(data) ? (data as Hotspot[]) : [];
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// Scroll from currentY toward targetY in 2-4 small steps with short pauses,
// so the captured stream sees a smooth glide rather than a viewport-sized jump.
// Emits a single summarized tool:scroll event so the narrator gets one
// reaction per glide instead of N.
async function glideTo(
  sid: string,
  targetY: number,
  currentY: number,
  step: number,
): Promise<void> {
  const delta = targetY - currentY;
  if (Math.abs(delta) < 4) return;
  const steps = jitter(GLIDE_STEPS_MIN, GLIDE_STEPS_MAX + 1);
  const direction: "down" | "up" = delta >= 0 ? "down" : "up";
  const perStep = Math.max(1, Math.round(Math.abs(delta) / steps));

  for (let i = 0; i < steps; i++) {
    await pwCall(`/session/${sid}/scroll`, { direction, amount: perStep });
    await sleep(jitter(GLIDE_STEP_PAUSE_MIN_MS, GLIDE_STEP_PAUSE_MAX_MS));
  }
  log("tool", {
    step,
    name: "scroll",
    input: { direction, amount: Math.abs(delta), glide: true, steps },
  });
}

// Old viewport-jump scroll loop, kept as a fallback for sites with zero
// qualifying hotspots (e.g., liveuamap's map UI, drudge's tiny ALL-CAPS
// headlines that fail the 20-char minimum).
async function slowScrollFallback(
  sid: string,
  site: { name: string; url: string },
  siteEnd: number,
  startStep: number,
): Promise<number> {
  let step = startStep;
  let lastScrollY = await getScrollY(sid);
  let lastProgressAt = Date.now();
  while (Date.now() < siteEnd) {
    await scrollDown(sid, step++);
    await sleep(jitter(SCROLL_MIN_MS, SCROLL_MAX_MS));
    const y = await getScrollY(sid);
    if (y !== lastScrollY) {
      lastScrollY = y;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > STUCK_TIMEOUT_MS) {
      log("site_stuck", { site: site.name, scrollY: y, fallback: true, timeoutMs: STUCK_TIMEOUT_MS });
      return step;
    }
  }
  return step;
}

async function clickRef(sid: string, ref: string, step: number): Promise<boolean> {
  const res = await pwCall(`/session/${sid}/click`, { ref });
  console.log(`[agent] step=${step} tool=click ref=${ref} -> ${res.ok ? "ok" : res.error}`);
  log("tool", {
    step,
    name: "click",
    input: { ref },
    error: res.ok ? undefined : res.error,
  });
  return res.ok;
}

async function dwellOnArticle(sid: string, step: number): Promise<void> {
  const dwellEnd = Date.now() + jitter(ARTICLE_DWELL_MIN_MS, ARTICLE_DWELL_MAX_MS);
  // Brief settle so the article finishes loading before the first scroll.
  await sleep(2_000);
  while (Date.now() < dwellEnd) {
    await scrollDown(sid, step);
    await sleep(jitter(SCROLL_MIN_MS, SCROLL_MAX_MS));
  }
}

async function runSite(
  sid: string,
  site: { name: string; url: string },
  startStep: number,
): Promise<number> {
  let step = startStep;
  await navigateTo(sid, site.url, step++);
  // Snapshot first so anchors carry data-ai-ref attributes; hotspot extraction
  // reads those refs so we can click the same element later without a fresh
  // snapshot invalidating them.
  await snapshot(sid);

  let queue: Hotspot[] = shuffle(await extractHotspots(sid));
  console.log(`[agent] site=${site.name} initial hotspots=${queue.length}`);
  log("hotspots", { site: site.name, count: queue.length });

  const siteEnd = Date.now() + DWELL_MS;
  let nextClickAt = Date.now() + jitter(CLICK_MIN_MS, CLICK_MAX_MS);
  let lastScrollY = await getScrollY(sid);
  let lastProgressAt = Date.now();

  while (Date.now() < siteEnd) {
    try {
      // Refill the queue when empty — catches lazy-loaded content. If there
      // are still no hotspots, fall back to the slow-rhythmic scroll for the
      // remaining budget rather than spinning here.
      if (queue.length === 0) {
        await snapshot(sid);
        queue = shuffle(await extractHotspots(sid));
        if (queue.length === 0) {
          console.log(`[agent] site=${site.name} no hotspots; slow-scroll fallback`);
          log("hotspot_fallback", { site: site.name });
          step = await slowScrollFallback(sid, site, siteEnd, step);
          break;
        }
      }

      const hotspot = queue.shift()!;
      console.log(
        `[agent] hotspot site=${site.name} y=${hotspot.y} text="${hotspot.text}"`,
      );

      const currentY = await getScrollY(sid);
      await glideTo(sid, hotspot.y, currentY, step++);
      await sleep(jitter(HOTSPOT_DWELL_MIN_MS, HOTSPOT_DWELL_MAX_MS));

      const y = await getScrollY(sid);
      if (y !== lastScrollY) {
        lastScrollY = y;
        lastProgressAt = Date.now();
      } else if (Date.now() - lastProgressAt > STUCK_TIMEOUT_MS) {
        console.log(`[agent] stuck on ${site.name}; rotating`);
        log("site_stuck", { step, site: site.name, scrollY: y, timeoutMs: STUCK_TIMEOUT_MS });
        break;
      }

      // Optional re-read: glide back a touch as if the headline caught a
      // second look, then continue.
      if (Math.random() < REVERSE_GLIDE_PROBABILITY) {
        const back = jitter(REVERSE_GLIDE_PX_MIN, REVERSE_GLIDE_PX_MAX);
        await glideTo(sid, Math.max(0, y - back), y, step++);
        await sleep(jitter(GLIDE_STEP_PAUSE_MIN_MS * 2, GLIDE_STEP_PAUSE_MAX_MS * 2));
      }

      // Click into the hotspot we just dwelled on (not a fresh random ref) if
      // the cooldown has elapsed and there's enough budget for an article visit.
      const now = Date.now();
      const budget = siteEnd - now;
      if (
        now >= nextClickAt &&
        budget > ARTICLE_DWELL_MAX_MS + 5_000 &&
        hotspot.ref
      ) {
        const clicked = await clickRef(sid, hotspot.ref, step++);
        if (clicked) {
          await dwellOnArticle(sid, step++);
          await navigateTo(sid, site.url, step++);
          await snapshot(sid);
          queue = shuffle(await extractHotspots(sid));
          lastScrollY = await getScrollY(sid);
          lastProgressAt = Date.now();
        }
        nextClickAt = Date.now() + jitter(CLICK_MIN_MS, CLICK_MAX_MS);
      }
    } catch (e) {
      console.error(`[agent] step=${step} loop error:`, e);
      log("tool_error", { step, site: site.name, error: String(e) });
      await sleep(2_000);
    }
  }

  return step;
}

async function main() {
  console.log(`[agent] session=${SESSION_ID}; base=${BASE}`);
  log("session_start", { session_id: SESSION_ID, base: BASE });

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/sessions`);
      if (r.ok) break;
    } catch {}
    await sleep(2_000);
  }

  const sid = await createSession();
  console.log(`[agent] created browser session ${sid}`);
  log("browser_session_ready", { browser_session: sid });

  let step = 0;
  let lastSite: string | null = null;
  while (true) {
    const choices = SITES.filter((s) => s.name !== lastSite);
    const site = pick(choices);
    console.log(`[agent] rotating to site=${site.name}`);
    log("site_rotation", { site: site.name, url: site.url });
    step = await runSite(sid, site, step);
    lastSite = site.name;
  }
}

main().catch((e) => {
  console.error("[agent] fatal:", e);
  process.exit(1);
});
