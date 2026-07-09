/**
 * Thin controller — the REAL integration status of every swappable vendor seat, for the
 * internal Platform Admin screen. Nothing here is asserted by hand: each row reflects the
 * adapter/provider the container actually resolved (so a mock is labeled simulated and a
 * missing key reads "not configured" — never a hardcoded "Connected" badge).
 */

import { NextResponse } from "next/server";
import { getContainer } from "@lib/container";
import { getEmbeddingMode, getEmbeddingProvider } from "@lib/embeddings";
import { env } from "@lib/env";
import { CLASSIFIERS } from "@modules/compliance";
import { firstAvailableComposer, getComposer } from "@modules/content";
import { getAvatarProvider, getRealtimeProvider, getVoiceProvider } from "@modules/vendors";

export const dynamic = "force-dynamic";

type Status = "connected" | "simulated" | "not_configured";

function seat(role: string, vendor: string, status: Status, detail?: string) {
  return { role, vendor, status, ...(detail ? { detail } : {}) };
}

export async function GET(): Promise<NextResponse> {
  const c = await getContainer();
  const realtime = getRealtimeProvider();
  const voice = getVoiceProvider();
  const avatar = getAvatarProvider();
  // Same resolution the container uses: the classifier's composer, else the first with a key.
  const activeComposer = getComposer(env.classifierProvider) ?? firstAvailableComposer();
  const composerLive = env.composeMode === "llm" && Boolean(activeComposer?.available());
  // The vector index embeds lazily (first query), so force one probe embed here — the
  // status page must report what retrieval ACTUALLY runs on, not "unknown".
  if (getEmbeddingMode() === "unknown") {
    await getEmbeddingProvider().embed(["integration status probe"]).catch(() => {});
  }
  const embedMode = getEmbeddingMode();

  const seats = [
    seat(
      "Realtime / conversation",
      realtime.name === "tavus" ? "Tavus CVI" : "Mock realtime",
      realtime.name === "tavus" ? "connected" : "simulated",
      realtime.name === "tavus" ? "Replies produced by the NexusRep compliance endpoint" : "Set TAVUS_API_KEY for the live video rep",
    ),
    seat("Voice — TTS / ASR", voice.name === "mock" ? "Browser speech (built-in)" : voice.name, voice.name === "mock" ? "simulated" : "connected"),
    seat("Avatar", avatar.name === "mock" ? "TalkingHead 3D (built-in) · Tavus replica" : avatar.name, env.tavusApiKey ? "connected" : "simulated"),
    seat(
      "Retrieval index",
      env.retrievalProvider === "pgvector"
        ? "pgvector"
        : embedMode === "neural"
          ? "Neural embeddings (MiniLM, on-device) · in-memory index"
          : "Lexical embeddings · in-memory index",
      // Real semantic embeddings ARE real retrieval — pgvector is a scale choice, not a realness one.
      env.retrievalProvider === "pgvector" || embedMode === "neural" ? "connected" : "simulated",
      embedMode === "unknown" ? "Resolves on first retrieval" : undefined,
    ),
    seat(
      "Answer composition",
      composerLive ? `Grounded LLM (${activeComposer!.name})` : "Deterministic (verbatim approved blocks)",
      composerLive ? "connected" : "simulated",
      composerLive ? "Grounding-validated + gated" : "Set NEXUSREP_COMPOSE=llm + a provider key to enable grounded rephrasing",
    ),
    seat(
      "Audience / claims",
      String(c.demo.audienceSource).startsWith("docnexus") ? "DocNexus Advanced Search (live claims)" : "Modeled cohort",
      String(c.demo.audienceSource).startsWith("docnexus") ? "connected" : "simulated",
    ),
  ];

  const classifiers = CLASSIFIERS.map((cl) => ({ name: cl.name, available: cl.available() }));

  const crmName = c.crm.adapterName;
  const crm = [
    {
      name: /mock/i.test(crmName) ? "NexusRep outbox (simulated CRM)" : crmName,
      status: (/mock/i.test(crmName) ? "simulated" : "connected") as Status,
      active: true,
      detail: "Escalations enqueue + deliver through this adapter",
    },
    { name: "Veeva Vault CRM", status: "not_configured" as Status, active: false },
    { name: "Salesforce Life Sciences", status: "not_configured" as Status, active: false },
    { name: "CSV / JSON export", status: "not_configured" as Status, active: false },
  ];

  return NextResponse.json({ seats, classifiers, crm });
}
