/**
 * Embeddings for controlled retrieval. Real semantic embeddings via a local
 * neural model (Transformers.js / all-MiniLM-L6-v2 — no API key, downloads once,
 * runs on-device), with a deterministic stemmed-lexical fallback if the model
 * can't load (offline/CI). Both produce 384-dim L2-normalized vectors so cosine
 * works the same way; the vector index never decides eligibility (that's the
 * source validator + compliance gate).
 */

const DIM = 384;

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── Lexical fallback (deterministic, offline) ────────────────────────────────
function stem(token: string): string {
  let t = token;
  for (const suf of ["ing", "edly", "ed", "ly", "es", "s"]) {
    if (t.length - suf.length >= 3 && t.endsWith(suf)) { t = t.slice(0, -suf.length); break; }
  }
  if (t.length > 3 && t.endsWith("e")) t = t.slice(0, -1); // dose/dosing/doses → dos
  return t;
}
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h % DIM;
}
// Drop stopwords so content terms (dose, safety, onset…) decide ranking, not "the/is".
const STOP = new Set([
  "the", "is", "a", "an", "of", "to", "in", "and", "or", "at", "as", "with", "for", "on", "by",
  "be", "are", "was", "it", "this", "that", "from", "per", "what", "which", "how", "do", "does",
  "can", "i", "you", "your", "me", "my", "about", "tell", "show", "approved", "information",
]);
export function lexicalEmbed(text: string): number[] {
  const vec = new Array<number>(DIM).fill(0);
  for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(raw)) continue;
    const s = stem(raw);
    if (s.length < 2) continue;
    vec[hash(s)] = (vec[hash(s)] ?? 0) + 1;
  }
  const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0));
  return norm ? vec.map((v) => v / norm) : vec;
}

const lexicalProvider: EmbeddingProvider = {
  name: "lexical-stemmed",
  async embed(texts) { return texts.map(lexicalEmbed); },
};

// ── Neural (Transformers.js, local) ──────────────────────────────────────────
let pipePromise: Promise<(t: string, o: object) => Promise<{ data: ArrayLike<number> }>> | null = null;
function getPipe() {
  if (!pipePromise) {
    pipePromise = (async () => {
      // Hugging Face 403s anonymous downloads from many datacenter IPs (e.g. Render), which drops
      // us to the lexical fallback. transformers.js authenticates by reading process.env.HF_TOKEN
      // (or HF_ACCESS_TOKEN) and sending `Authorization: Bearer` (see @xenova/transformers hub.js) —
      // so a read-only HF_TOKEN set on the host is all it needs. Bridge the common alt name so
      // either works. NB: setting tf.env.HF_TOKEN does NOTHING — the lib only reads process.env.
      if (!process.env.HF_TOKEN && process.env.HUGGING_FACE_HUB_TOKEN) {
        process.env.HF_TOKEN = process.env.HUGGING_FACE_HUB_TOKEN;
      }
      const tf = (await import("@xenova/transformers")) as unknown as {
        env: { allowLocalModels: boolean };
        pipeline: (task: string, model: string) => Promise<(t: string, o: object) => Promise<{ data: ArrayLike<number> }>>;
      };
      tf.env.allowLocalModels = false;
      const model = process.env.NEXUSREP_EMBEDDINGS_MODEL || "Xenova/all-MiniLM-L6-v2";
      return tf.pipeline("feature-extraction", model);
    })();
  }
  return pipePromise;
}
const neuralProvider: EmbeddingProvider = {
  name: "neural-minilm",
  async embed(texts) {
    const pipe = await getPipe();
    const out: number[][] = [];
    for (const t of texts) {
      const r = await pipe(t, { pooling: "mean", normalize: true });
      out.push(Array.from(r.data as ArrayLike<number>));
    }
    return out;
  },
};

/** Tries neural, falls back to lexical on any error, then sticks with the choice. */
const autoProvider: EmbeddingProvider = {
  name: "auto(neural→lexical)",

  async embed(texts) {
    if (autoMode !== "lexical") {
      try {
        const r = await neuralProvider.embed(texts);
        autoMode = "neural";
        return r;
      } catch (e) {
        console.warn("[embeddings] neural model unavailable, using lexical fallback:", e instanceof Error ? e.message : e);
        autoMode = "lexical";
      }
    }
    return lexicalProvider.embed(texts);
  },
};
let autoMode: "neural" | "lexical" | "unknown" = "unknown";

export function getEmbeddingProvider(): EmbeddingProvider {
  // Tests/CI stay deterministic + offline.
  if (process.env.VITEST || process.env.NODE_ENV === "test") return lexicalProvider;
  const mode = process.env.NEXUSREP_EMBEDDINGS;
  if (mode === "lexical") return lexicalProvider;
  if (mode === "neural") return neuralProvider;
  return autoProvider;
}

/** What the auto provider actually resolved to at runtime ("unknown" until the first embed).
 *  Surfaced on the integrations screen so retrieval is labeled by what it truly runs on. */
export function getEmbeddingMode(): "neural" | "lexical" | "unknown" {
  if (process.env.VITEST || process.env.NODE_ENV === "test") return "lexical";
  const mode = process.env.NEXUSREP_EMBEDDINGS;
  if (mode === "lexical") return "lexical";
  if (mode === "neural") return "neural";
  return autoMode;
}
