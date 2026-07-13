"use client";

/**
 * Client hook for the video-agent gallery (the account's trained agents + the vendor's
 * stock library). Fetched once from /api/realtime/agents and cached at module scope —
 * mirroring useBrand — so switching Studio tabs and coming back to Agent mode is instant
 * instead of re-hitting the vendor list every mount (the list is 90+ agents).
 *
 * A select/create POST returns a fresh payload; the caller pushes it back with
 * setAgentsCache() so the shared cache (and every mounted consumer) stays current.
 * Vendor-neutral: only the canonical AgentSummary shape crosses this boundary.
 */

import { useCallback, useEffect, useState } from "react";

export interface AgentInfo {
  id: string;
  name: string;
  kind: "stock" | "personal";
  status: "ready" | "training" | "error";
  thumbnailUrl?: string;
}

export interface AgentsPayload {
  configured: boolean;
  selected: string | null;
  selectedName: string | null;
  /** Persisted video-off voice (OpenAI voice id) — the rep's voice when video is off, or null = default. */
  voiceId?: string | null;
  /** When true, that voice is used for the whole conversation (video on too), not just video-off. */
  voiceWholeConvo?: boolean;
  defaultReplicaId: string | null;
  agents: AgentInfo[];
  note?: string;
  error?: string;
}

let cache: AgentsPayload | null = null;
let inflight: Promise<AgentsPayload | null> | null = null;
const AGENTS_CHANGED = "nexusrep:agents-changed";

function load(force = false): Promise<AgentsPayload | null> {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/realtime/agents")
      .then((r) => (r.ok ? (r.json() as Promise<AgentsPayload>) : null))
      .catch(() => null)
      .then((d) => {
        inflight = null; // failure → next call retries; success → cache serves everyone
        if (d) {
          cache = d;
          if (typeof window !== "undefined") window.dispatchEvent(new Event(AGENTS_CHANGED));
        }
        return d;
      });
  }
  return inflight;
}

/** Push a fresh payload (e.g. the response to a select/create POST) into the shared cache. */
export function setAgentsCache(d: AgentsPayload): void {
  cache = d;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AGENTS_CHANGED));
}

export function invalidateAgentsCache(): void {
  cache = null;
  inflight = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AGENTS_CHANGED));
}

export interface UseAgents {
  data: AgentsPayload | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useAgents(): UseAgents {
  const [data, setData] = useState<AgentsPayload | null>(cache);
  const [loading, setLoading] = useState<boolean>(!cache);

  const refresh = useCallback(async () => {
    setLoading(true);
    const d = await load(true);
    if (d) setData(d);
    setLoading(false);
  }, []);

  useEffect(() => {
    let alive = true;
    const onChanged = () => { if (alive && cache) setData(cache); };
    if (cache) {
      setData(cache);
      setLoading(false);
    } else {
      void load().then((d) => {
        if (!alive) return;
        if (d) setData(d);
        setLoading(false);
      });
    }
    window.addEventListener(AGENTS_CHANGED, onChanged);
    return () => { alive = false; window.removeEventListener(AGENTS_CHANGED, onChanged); };
  }, []);

  return { data, loading, refresh };
}
