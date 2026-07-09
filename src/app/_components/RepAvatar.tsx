"use client";

/**
 * AI-rep avatar. Renders REAL local video when a webcam MediaStream is provided
 * (getUserMedia) and a locally-animated speaking indicator (an equalizer that
 * animates only while real speech is playing). No vendor, no keys — a synthetic
 * photorealistic talking head would require an avatar vendor (Tavus/HeyGen/D-ID),
 * which plugs in behind this same component later.
 */

import { useEffect, useRef } from "react";

export function RepAvatar({
  speaking,
  stream,
  status,
  height = 240,
}: {
  speaking: boolean;
  stream: MediaStream | null;
  status: string;
  height?: number;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (el && stream) {
      el.srcObject = stream;
      void el.play().catch(() => {});
    }
  }, [stream]);

  return (
    <div
      aria-label="AI representative video"
      data-speaking={speaking}
      style={{
        height,
        borderRadius: "var(--dn-radius-lg)",
        background: "var(--dn-gradient-primary)",
        position: "relative",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {stream && (
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, color: "#fff" }}>
        <div className="rep-eq" data-on={speaking}>
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <span style={{ fontSize: 13, opacity: 0.92, textShadow: "0 1px 4px rgba(0,0,0,.3)" }}>{status}</span>
      </div>
    </div>
  );
}
