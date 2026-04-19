"use client";

import { useEffect, useRef, useState } from "react";

const GLITCH_MS = 5000;

/**
 * Full-bleed overlay that plays /glitch.mp4 on loop for GLITCH_MS, then fades
 * out. Renders its children underneath so they're ready by the time the glitch
 * finishes. Keyed on `token` so passing a new value (e.g. a new session id)
 * retriggers the effect.
 */
export default function GlitchTransition({
  token,
  children,
}: {
  token: string;
  children: React.ReactNode;
}) {
  const [visible, setVisible] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setVisible(true);
    const t = setTimeout(() => setVisible(false), GLITCH_MS);
    return () => clearTimeout(t);
  }, [token]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    v.play().catch(() => {});
  }, [token, visible]);

  return (
    <div className="relative">
      {children}
      {visible && (
        <div className="fixed inset-0 z-50 bg-black pointer-events-none transition-opacity duration-300">
          <video
            ref={videoRef}
            src="/glitch.mp4"
            autoPlay
            muted
            loop
            playsInline
            className="w-full h-full object-cover"
          />
        </div>
      )}
    </div>
  );
}
