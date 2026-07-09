"use client";

/**
 * Doctor-facing entry point (the shareable "sent to the HCP" link). It renders the
 * SAME experience as the in-app "Preview HCP experience" — there is ONE doctor view
 * (`HcpExperience`), so what you preview is exactly what the doctor receives.
 *
 * `?bare=1` renders only the full-bleed Tavus replica (used by the recorder to
 * capture a clean clip of just the rep).
 */

import { useEffect, useState } from "react";
import { HcpExperience } from "../_app/HcpExperience";
import { TavusStage } from "../_components/TavusStage";

export default function HcpRoute() {
  // Render the doctor view immediately (no blank flash); only the recorder's rare
  // ?bare=1 flips to the full-bleed replica clip view.
  const [bare, setBare] = useState(false);
  const [hcp, setHcp] = useState("");
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("bare") === "1") setBare(true);
    setHcp(params.get("hcp") ?? ""); // per-doctor invite identity (validated server-side)
  }, []);
  if (bare) return <TavusStage bare onClose={() => setBare(false)} hcpId={hcp || undefined} />;
  return <HcpExperience />;
}
