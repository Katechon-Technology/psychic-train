// Connects as a spectator bot to the Minecraft server and serves a 3D view of
// the world via prismarine-viewer on port 3007. The launch.sh script opens a
// Chromium kiosk at http://localhost:3007 which is what ffmpeg captures.

import mineflayer from "mineflayer";
import pkg from "prismarine-viewer";
const { mineflayer: viewer } = pkg;

const {
  MC_HOST = "localhost",
  MC_PORT = "25565",
  VIEWER_USERNAME = "Spectator",
  VIEWER_PORT = "3007",
  VIEW_DISTANCE = "8",
} = process.env;

console.log(`[viewer] connecting spectator ${VIEWER_USERNAME} to ${MC_HOST}:${MC_PORT}`);

const bot = mineflayer.createBot({
  host: MC_HOST,
  port: Number(MC_PORT),
  username: VIEWER_USERNAME,
  auth: "offline",
});

bot.on("error", (e) => console.error("[viewer] error:", e.message));
bot.on("kicked", (r) => console.warn("[viewer] kicked:", r));

bot.once("spawn", () => {
  console.log("[viewer] spawned; starting prismarine-viewer");
  viewer(bot, {
    port: Number(VIEWER_PORT),
    firstPerson: false,
    viewDistance: Number(VIEW_DISTANCE),
  });

  // Try to follow the ClaudeBot around if it's on the server.
  setInterval(() => {
    const target = Object.values(bot.entities).find(
      (e) => e.type === "player" && e.username && e.username !== VIEWER_USERNAME,
    );
    if (target) {
      // mineflayer doesn't expose spectate easily; we just chat-teleport when op.
      bot.chat(`/tp ${VIEWER_USERNAME} ${target.username}`);
    }
  }, 8000);
});
