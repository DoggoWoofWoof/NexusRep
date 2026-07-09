/**
 * Mock vendor adapters. Real interfaces, fake backends. These let the entire
 * product run end-to-end with no API keys and no network — and they are what
 * E2E/CI test against (brief §20, §21 Stage 2).
 */

import type {
  AudioInput,
  AudioStream,
  AvatarConfig,
  AvatarProvider,
  CrmAdapter,
  CrmDeliveryResult,
  CrmEventPayload,
  RealtimeProvider,
  RealtimeSession,
  RealtimeSessionConfig,
  RealtimeSystemEvent,
  RetrievalProvider,
  SpeakInput,
  ToolResult,
  Transcript,
  VoiceConfig,
  VoiceProvider,
} from "./types";
import type { VectorIndex } from "@lib/vector-index";

export class MockRealtimeProvider implements RealtimeProvider {
  readonly name = "mock";
  private session: RealtimeSession | null = null;
  readonly events: RealtimeSystemEvent[] = [];
  readonly toolResults: ToolResult[] = [];

  async startSession(config: RealtimeSessionConfig): Promise<RealtimeSession> {
    this.session = { id: config.sessionId, provider: this.name, startedAt: 0 };
    return this.session;
  }
  async sendSystemEvent(event: RealtimeSystemEvent): Promise<void> {
    this.events.push(event);
  }
  async sendToolResult(result: ToolResult): Promise<void> {
    this.toolResults.push(result);
  }
  async endSession(): Promise<void> {
    this.session = null;
  }
}

export class MockVoiceProvider implements VoiceProvider {
  readonly name = "mock";
  async transcribe(audio: AudioInput): Promise<Transcript> {
    const text = typeof audio.bytes === "string" ? audio.bytes : "[mock audio]";
    return { text, confidence: 0.99 };
  }
  async synthesize(text: string, _voice: VoiceConfig): Promise<AudioStream> {
    return { ref: `mock-audio:${text.slice(0, 24)}`, durationMs: Math.max(800, text.length * 45) };
  }
}

export class MockAvatarProvider implements AvatarProvider {
  readonly name = "mock";
  readonly spoken: SpeakInput[] = [];
  readonly slidesShown: string[] = [];
  async startAvatar(_config: AvatarConfig): Promise<void> {}
  async speak(input: SpeakInput): Promise<void> {
    this.spoken.push(input);
  }
  async showDetailAid(slideId: string): Promise<void> {
    this.slidesShown.push(slideId);
  }
  async endAvatar(): Promise<void> {}
}

/** Mock CRM adapter: succeeds, but flags missing NPI as needs_mapping to exercise that path. */
export class MockCrmAdapter implements CrmAdapter {
  readonly name = "outbox-mock";
  async deliver(payload: CrmEventPayload): Promise<CrmDeliveryResult> {
    if (!payload.hcpNpi) return { status: "needs_mapping", detail: "missing hcp_npi mapping" };
    return { status: "sent" };
  }
}

/** Mock retrieval provider backed by the in-memory vector index. IDs only. */
export class MockRetrievalProvider implements RetrievalProvider {
  readonly name = "memory-vector";
  constructor(private readonly index: VectorIndex) {}
  async retrieve(query: { text: string; filter?: Record<string, string>; topK?: number }) {
    const candidates = await this.index.query({
      text: query.text,
      filter: query.filter,
      topK: query.topK,
    });
    return candidates.map((c) => ({ refId: c.refId, score: c.score }));
  }
}
