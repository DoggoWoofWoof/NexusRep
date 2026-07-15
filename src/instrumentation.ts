/**
 * Next.js server instrumentation. `register()` runs ONCE when the server process boots — after
 * the build, on every runtime start and instance spin-up. We use it to PRE-LOAD the neural
 * embedding model so retrieval is warm before the first request instead of lazy-loading on the
 * first doctor turn (the cold load — transformers.js import + ONNX init + first-ever download —
 * was landing on turn 1 while Tavus waited on our reply).
 *
 * Fire-and-forget: we do NOT await the warmup, so the server starts serving immediately; the model
 * loads in the background and is ready within a second or two, well before a live call's first
 * turn. If a request somehow arrives mid-load, it shares the same cached load promise (getPipe),
 * so nothing double-loads.
 */
export async function register(): Promise<void> {
  // transformers.js is Node-only; skip the edge runtime and any non-server context.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { warmupEmbeddings } = await import("@lib/embeddings");
  void warmupEmbeddings();
}
