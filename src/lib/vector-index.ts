/**
 * Vector index abstraction (pgvector-ready). It retrieves *candidate IDs only*.
 * It never decides whether content is allowed — source validation + the
 * compliance gate do that (brief §15, §17). Embeddings come from a real
 * EmbeddingProvider (neural with lexical fallback — see src/lib/embeddings.ts);
 * swapping to pgvector means implementing this interface, no caller changes.
 */

import { cosine, getEmbeddingProvider, type EmbeddingProvider } from "./embeddings";

export interface VectorRecord {
  /** Canonical id of the approved object this embedding points back to. */
  refId: string;
  /** Arbitrary metadata used for pre-filtering (audience, indication, status…). */
  metadata: Record<string, string>;
  /** Text to embed (topic + approved block). Embedded lazily via the provider. */
  text: string;
}

export interface VectorQuery {
  text: string;
  filter?: Record<string, string>;
  topK?: number;
}

export interface VectorCandidate {
  refId: string;
  score: number;
}

export interface VectorIndex {
  upsert(record: VectorRecord): Promise<void>;
  /** Returns candidate refIds ranked by similarity. IDs only — not content. */
  query(query: VectorQuery): Promise<VectorCandidate[]>;
}

interface StoredRecord extends VectorRecord {
  vec?: number[];
}

export class InMemoryVectorIndex implements VectorIndex {
  private readonly records: StoredRecord[] = [];

  constructor(private readonly provider: EmbeddingProvider = getEmbeddingProvider()) {}

  async upsert(record: VectorRecord): Promise<void> {
    const idx = this.records.findIndex((r) => r.refId === record.refId);
    const stored: StoredRecord = { ...record };
    if (idx >= 0) this.records[idx] = stored;
    else this.records.push(stored);
  }

  /** Embed any not-yet-embedded records (one batch) so the provider loads once. */
  private async ensureEmbedded(): Promise<void> {
    const pending = this.records.filter((r) => !r.vec);
    if (pending.length === 0) return;
    const vecs = await this.provider.embed(pending.map((r) => r.text));
    pending.forEach((r, i) => { r.vec = vecs[i]; });
  }

  /** Explicit startup warmup so the first live doctor turn doesn't pay to embed the whole deck. */
  async warmup(): Promise<void> {
    await this.ensureEmbedded();
  }

  async query(query: VectorQuery): Promise<VectorCandidate[]> {
    await this.ensureEmbedded();
    const [qVec] = await this.provider.embed([query.text]);
    if (!qVec) return [];
    return this.records
      .filter((r) => matchesFilter(r.metadata, query.filter))
      .map((r) => ({ refId: r.refId, score: r.vec ? cosine(qVec, r.vec) : 0 }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.topK ?? 5);
  }
}

function matchesFilter(meta: Record<string, string>, filter?: Record<string, string>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => meta[k] === v);
}
