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
    });
  }
  return new MockRealtimeProvider();
}

export { TavusRealtimeProvider, type TavusConfig } from "./tavus";

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
