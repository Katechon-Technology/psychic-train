import { execa } from "execa";

const DISPLAY = process.env.DISPLAY ?? ":1";

async function xdo(args: string[]): Promise<string> {
  const r = await execa("xdotool", args, { env: { DISPLAY }, reject: false });
  if (r.exitCode !== 0) {
    throw Object.assign(new Error(`xdotool failed: ${r.stderr || r.stdout}`), {
      statusCode: 500,
    });
  }
  return r.stdout;
}

export async function mouseMove(x: number, y: number): Promise<void> {
  await xdo(["mousemove", String(x), String(y)]);
}

export async function mouseClick(opts: {
  x?: number;
  y?: number;
  button?: number; // 1=left, 2=middle, 3=right, 4=scroll up, 5=scroll down
  double?: boolean;
}): Promise<void> {
  if (opts.x !== undefined && opts.y !== undefined) {
    await xdo(["mousemove", String(opts.x), String(opts.y)]);
  }
  const btn = String(opts.button ?? 1);
  if (opts.double) {
    await xdo(["click", "--repeat", "2", btn]);
  } else {
    await xdo(["click", btn]);
  }
}

export async function mouseScroll(dy: number, x?: number, y?: number): Promise<void> {
  if (x !== undefined && y !== undefined) {
    await xdo(["mousemove", String(x), String(y)]);
  }
  const button = dy < 0 ? "4" : "5";
  const ticks = Math.min(40, Math.max(1, Math.round(Math.abs(dy) / 40)));
  for (let i = 0; i < ticks; i++) {
    await xdo(["click", button]);
  }
}

export async function keyboardType(text: string, delayMs?: number): Promise<void> {
  // xdotool's --delay is in ms between keystrokes.
  await xdo(["type", "--delay", String(Math.max(0, delayMs ?? 12)), "--", text]);
}

export async function keyboardKey(key: string): Promise<void> {
  // xdotool key accepts e.g. "Return", "ctrl+l", "shift+Tab".
  await xdo(["key", "--", key]);
}
