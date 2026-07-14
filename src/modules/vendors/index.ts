/**
 * Vendor module public surface. Core services resolve providers through this
 * registry only — they never import a concrete adapter. Switching a provider is
 * an env change (see src/lib/env.ts and docs/VENDOR_EVAL.md), not a code change.
 *
 * Today every selection resolves to a mock. Real adapters (gpt-realtime, tavus,
 * veeva…) get added here behind the same interfaces with no caller impact.
 */

import { env } from "@lib/env";
import { InMemoryVectorIndex, type VectorIndex } from "@lib/vector-index";
import {
  MockAvatarProvider,
  MockCrmAdapter,
  MockRealtimeProvider,
  MockRetrievalProvider,
  MockVoiceProvider,
} from "./mock";
import { TavusRealtimeProvider } from "./tavus";
import { hasAgentCatalog } from "./types";
import type {
  AvatarProvider,
  CrmAdapter,
  RealtimeProvider,
  RetrievalProvider,
  VoiceProvider,
} from "./types";

export * from "./types";

export function getRealtimeProvider(): RealtimeProvider {
  // Real Tavus CVI when selected AND a key is present; otherwise the mock so the
  // app always runs. gpt-realtime lands here later behind the same interface.
  if (env.realtimeProvider === "tavus" && env.tavusApiKey) {
    return new TavusRealtimeProvider({
      apiKey: env.tavusApiKey,
      baseUrl: env.tavusBaseUrl,
      replicaId: env.tavusReplicaId,
      personaId: env.tavusPersonaId || undefined,
      tts: {
        engine: env.tavusTtsEngine,
        model: env.tavusTtsModel,
        speed: env.tavusTtsSpeed,
        emotionControl: env.tavusTtsEmotionControl,
      },
      sttEngine: env.tavusSttEngine,
    });
  }
  return new MockRealtimeProvider();
}

export { TavusRealtimeProvider, type TavusConfig } from "./tavus";

// The default video agent — "Charlie" — resolved BY NAME from the gallery so it's Charlie
// regardless of the deployment's env replica id (which may be someone else). Cached per process
// (the stock catalog is stable); falls back to env.tavusReplicaId when no Charlie is available.
let cachedDefaultAgentId: string | undefined;
export async function resolveDefaultAgentId(): Promise<string | undefined> {
  if (cachedDefaultAgentId !== undefined) return cachedDefaultAgentId || undefined;
  const provider = getRealtimeProvider();
  if (hasAgentCatalog(provider)) {
    try {
      const charlie = (await provider.listAgents()).find((a) => /\bcharlie\b/i.test(a.name) && a.status === "ready");
      if (charlie) { cachedDefaultAgentId = charlie.id; return charlie.id; }
    } catch { /* fall through to the env default */ }
  }
  cachedDefaultAgentId = env.tavusReplicaId || "";
  return cachedDefaultAgentId || undefined;
}

export function getVoiceProvider(): VoiceProvider {
  return new MockVoiceProvider();
}

export function getAvatarProvider(): AvatarProvider {
  return new MockAvatarProvider();
}

export function getCrmAdapter(): CrmAdapter {
  return new MockCrmAdapter();
}

export function getRetrievalProvider(index?: VectorIndex): RetrievalProvider {
  return new MockRetrievalProvider(index ?? new InMemoryVectorIndex());
}
