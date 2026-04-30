import { execa } from "execa";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";

const WORKSPACE = process.env.WORKSPACE ?? "/workspace";
const DISPLAY = process.env.DISPLAY ?? ":1";

/**
 * All filesystem operations are sandboxed to /workspace. Absolute paths are
 * accepted but must resolve under it; relative paths are joined to it.
 */
function safeJoin(p: string): string {
  const abs = isAbsolute(p) ? normalize(p) : normalize(join(WORKSPACE, p));
  if (!abs.startsWith(WORKSPACE)) {
    throw Object.assign(new Error(`path escapes workspace: ${p}`), { statusCode: 400 });
  }
  return abs;
}

export async function fsWrite(opts: { path: string; text?: string; content_b64?: string }): Promise<{
  path: string;
  bytes: number;
}> {
  const abs = safeJoin(opts.path);
  await mkdir(dirname(abs), { recursive: true });
  let buf: Buffer;
  if (opts.content_b64 !== undefined) {
    buf = Buffer.from(opts.content_b64, "base64");
  } else if (opts.text !== undefined) {
    buf = Buffer.from(opts.text, "utf8");
  } else {
    throw Object.assign(new Error("provide text or content_b64"), { statusCode: 400 });
  }
  await writeFile(abs, buf);
  return { path: abs, bytes: buf.length };
}

export async function fsRead(opts: { path: string; max_bytes?: number }): Promise<{
  path: string;
  text: string;
  truncated: boolean;
  bytes: number;
}> {
  const abs = safeJoin(opts.path);
  const buf = await readFile(abs);
  const cap = Math.min(opts.max_bytes ?? 16_000, 64_000);
  const truncated = buf.length > cap;
  return {
    path: abs,
    text: buf.slice(0, cap).toString("utf8"),
    truncated,
    bytes: buf.length,
  };
}

export async function fsList(opts: { path: string }): Promise<{
  path: string;
  entries: Array<{ name: string; type: "file" | "dir"; bytes?: number }>;
}> {
  const abs = safeJoin(opts.path);
  const names = await readdir(abs);
  const entries = await Promise.all(
    names.map(async (n) => {
      const s = await stat(join(abs, n)).catch(() => null);
      if (!s) return { name: n, type: "file" as const };
      return s.isDirectory()
        ? { name: n, type: "dir" as const }
        : { name: n, type: "file" as const, bytes: s.size };
    }),
  );
  return { path: abs, entries };
}

/**
 * Opens an arbitrary file in a viewer window. Images go to feh (cheap, fast,
 * no toolbar clutter); everything else falls through to xdg-open.
 */
export async function fsOpen(opts: { path: string }): Promise<void> {
  const abs = safeJoin(opts.path);
  const lower = abs.toLowerCase();
  const isImage =
    lower.endsWith(".png") ||
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".gif") ||
    lower.endsWith(".webp") ||
    lower.endsWith(".bmp");
  if (isImage) {
    execa("feh", ["--scale-down", "--auto-zoom", abs], {
      env: { ...process.env, DISPLAY },
      reject: false,
      detached: true,
      stdio: "ignore",
    });
    return;
  }
  execa("xdg-open", [abs], {
    env: { ...process.env, DISPLAY },
    reject: false,
    detached: true,
    stdio: "ignore",
  });
}
