import { execa } from "execa";
import { readFile, unlink } from "node:fs/promises";

const DISPLAY = process.env.DISPLAY ?? ":1";

/**
 * Captures the current X display and returns the PNG as base64. Uses
 * ImageMagick's `import` tool — `-window root` grabs the entire virtual
 * display Xvfb is rendering, which is exactly what ffmpeg is also encoding
 * for the HLS stream. If `import` fails (rare), falls back to scrot.
 */
export async function screenshotFullDisplay(): Promise<{ png_b64: string; bytes: number }> {
  const path = `/tmp/desktop-shot-${Date.now()}.png`;
  let r = await execa("import", ["-window", "root", "-display", DISPLAY, path], {
    reject: false,
  });
  if (r.exitCode !== 0) {
    r = await execa("scrot", [path], { env: { DISPLAY }, reject: false });
  }
  if (r.exitCode !== 0) {
    throw Object.assign(new Error(`screenshot failed: ${r.stderr}`), { statusCode: 500 });
  }
  const buf = await readFile(path);
  await unlink(path).catch(() => {});
  return { png_b64: buf.toString("base64"), bytes: buf.length };
}
