import type { NextConfig } from "next";

// Server-side proxy for the /demo browser-side avatar. Browsers see a
// same-origin iframe at /demo-avatar/embed.html; Next.js forwards the
// request (including /assets/*, /api/*, websockets) to whatever URL can
// reach the vtuber-overlay container's :12393.
//
// In dev:  AVATAR_BACKEND_URL = http://vtuber-overlay:12393  (docker DNS)
// In prod: AVATAR_BACKEND_URL = https://vtuber.stream.claudetorio.ai
//          (already exposed by stream-server Caddy under the existing
//           *.stream.claudetorio.ai wildcard cert)
const AVATAR_BACKEND_URL =
  process.env.AVATAR_BACKEND_URL || "http://vtuber-overlay:12393";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/demo-avatar/:path*",
        destination: `${AVATAR_BACKEND_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
