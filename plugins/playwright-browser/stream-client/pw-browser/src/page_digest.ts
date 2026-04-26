import type { Page } from "playwright";

export interface PageDigest {
  url: string;
  title: string;
  description: string | null;
  headings: string[];
  items: string[];
  paragraphs: string[];
  chars: number;
}

// Held as a string and fed to page.evaluate for the same reason as SNAPSHOT_JS:
// esbuild's __name() wrapping would reference an undefined helper in the page.
const DIGEST_JS = `(() => {
  const trim = (s) => (s || '').trim().replace(/\\s+/g, ' ');

  const title = (document.title || '').slice(0, 200);

  let description = null;
  const md =
    document.querySelector('meta[name="description"]') ||
    document.querySelector('meta[property="og:description"]');
  if (md) {
    const c = md.getAttribute('content');
    if (c) description = trim(c).slice(0, 300);
  }

  const headings = [];
  const headingSeen = new Set();
  for (const h of document.querySelectorAll('h1, h2, h3')) {
    const t = trim(h.textContent).slice(0, 120);
    if (!t || t.length < 4) continue;
    if (headingSeen.has(t)) continue;
    headingSeen.add(t);
    headings.push(t);
    if (headings.length >= 15) break;
  }

  // Mirrors the bucketing in agent's HOTSPOT_EXTRACT_JS so the digest items
  // line up with the headlines the agent will visit.
  const items = [];
  const itemSeen = new Set();
  const buckets = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const r = a.getBoundingClientRect();
    if (r.height < 8) continue;
    const t = trim(a.textContent);
    if (t.length < 20 || t.length > 200) continue;
    if (itemSeen.has(t)) continue;
    const y = Math.round(r.top + window.scrollY);
    const bucket = Math.floor(y / 40);
    if (buckets.has(bucket)) continue;
    buckets.add(bucket);
    itemSeen.add(t);
    items.push(t);
    if (items.length >= 10) break;
  }

  const paragraphs = [];
  for (const p of document.querySelectorAll('p')) {
    const t = trim(p.textContent);
    if (t.length < 80) continue;
    paragraphs.push(t.slice(0, 240));
    if (paragraphs.length >= 3) break;
  }

  const sumChars = () =>
    title.length +
    (description ? description.length : 0) +
    headings.reduce((a, b) => a + b.length, 0) +
    items.reduce((a, b) => a + b.length, 0) +
    paragraphs.reduce((a, b) => a + b.length, 0);

  const CAP = 1800;
  while (sumChars() > CAP && paragraphs.length > 0) paragraphs.pop();
  while (sumChars() > CAP && items.length > 0) items.pop();
  while (sumChars() > CAP && headings.length > 0) headings.pop();

  return {
    url: location.href,
    title,
    description,
    headings,
    items,
    paragraphs,
    chars: sumChars(),
  };
})()`;

export async function buildDigest(page: Page): Promise<PageDigest> {
  const data = await page.evaluate(DIGEST_JS);
  return data as PageDigest;
}
