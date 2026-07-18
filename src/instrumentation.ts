/**
 * Next.js server instrumentation. `register()` runs ONCE when the server process boots — after
 * the build, on every runtime start and instance spin-up. We use it to PRE-LOAD the neural
 * embedding model, the demo containers, and the Tavus custom-LLM route module so retrieval and
 * the realtime callback are warm before the first request instead of lazy-loading on the first
 * doctor turn (the cold load — transformers.js import + ONNX init + first-ever download,
 * container seeding, plus dev-route compilation — was landing on turn 1 while Tavus waited on
 * our reply).
 *
 * Fire-and-forget: we do NOT await the warmup, so the server starts serving immediately; the model
 * loads in the background and is ready within a second or two, well before a live call's first
 * turn. If a request somehow arrives mid-load, it shares the same cached load promise (getPipe),
 * so nothing double-loads.
 */
type InstrumentationGlobal = typeof globalThis & { __nexusrepErrHandlers?: boolean };

export async function register(): Promise<void> {
  // transformers.js is Node-only; skip the edge runtime and any non-server context.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ warmupEmbeddings }, { getContainerForUser }, { DEMO_USERS, appAuthEnabled }, { env }, { logger }, { captureError, warnIfUnwiredTracker }] = await Promise.all([
    import("@lib/embeddings"),
    import("@lib/container"),
    import("@lib/auth-session"),
    import("@lib/env"),
    import("@lib/logger"),
    import("@lib/error-capture"),
  ]);
  const boot = logger.child("boot");

  // Global error capture: unhandled rejections / uncaught exceptions previously had NO capture path.
  // We log + forward (to any registered sink) but do NOT exit — a single stray rejection must not tear
  // down a live Tavus call; a truly fatal error will resurface. Guarded so dev HMR can't stack handlers.
  const g = globalThis as InstrumentationGlobal;
  if (!g.__nexusrepErrHandlers) {
    g.__nexusrepErrHandlers = true;
    process.on("unhandledRejection", (reason) => captureError(reason, { phase: "unhandledRejection" }));
    process.on("uncaughtException", (err) => captureError(err, { phase: "uncaughtException" }));
    warnIfUnwiredTracker();
  }

  // Fail-closed heads-up: a production deploy with auth on MUST set a private NEXUSREP_SESSION_SECRET —
  // the built-in default is public, so cookies would be forgeable. The brand API refuses (503) in this
  // state (see require-auth); this line makes the cause obvious in the boot logs.
  if (process.env.NODE_ENV === "production" && appAuthEnabled() && env.sessionSecretIsDefault) {
    boot.error("SECURITY: NEXUSREP_SESSION_SECRET is not set — the default cookie secret is public (forgeable sessions). The brand console returns 503 until you set NEXUSREP_SESSION_SECRET (or set NEXUSREP_AUTH=0 to run open).", { scope: "auth" });
  }
  void warmupEmbeddings();
  void (async () => {
    const started = Date.now();
    try {
      const users = appAuthEnabled() ? DEMO_USERS.filter((u) => u.data === "demo").map((u) => u.username) : [];
      await Promise.all([getContainerForUser(null), ...users.map((u) => getContainerForUser(u))]);
      boot.info(`container warmup complete in ${Date.now() - started}ms`, { users: users.length ? users : ["default"] });
    } catch (e) {
      boot.warn("container warmup failed (first request will lazy-load)", { error: e });
    }
  })();
  if (process.env.ANTHROPIC_API_KEY) {
    void import("@anthropic-ai/sdk").catch((e) => {
      boot.warn("Anthropic SDK warmup failed (first LLM call will import lazily)", { error: e });
    });
  }
  void (async () => {
    const started = Date.now();
    try {
      // Permanent no-credit Tavus callback warmup: import the module at server boot so dev/Turbopack
      // compiles it before the first live HCP turn. This does NOT call POST, authenticate, create a
      // Tavus conversation, hit Claude/OpenAI, or log a fake transcript turn.
      await import("@/app/api/tavus/llm/chat/completions/route");
      boot.info(`tavus-llm route warmup complete in ${Date.now() - started}ms`);
    } catch (e) {
      boot.warn("tavus-llm route warmup failed (first Tavus callback will lazy-load)", { error: e });
    }
  })();
}
