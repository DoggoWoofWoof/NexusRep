import { performance } from "node:perf_hooks";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "vitest";

const QUERIES = [
  { query: "How does Milvexian work?", route: "approved_answer", slide: "slide_moa", cue: true },
  { query: "How does mylovaxia work?", route: "approved_answer", slide: "slide_moa", cue: true },
  { query: "How does the vaccine work?", route: "approved_answer", slide: "slide_moa", cue: true },
  { query: "What is the LIBREXIA program?", route: "approved_answer", slide: "slide_program", cue: true },
  { query: "What is the LEBREXIA program?", route: "approved_answer", slide: "slide_program", cue: true },
  { query: "What are the three studies looking at?", route: "approved_answer", slide: "slide_program", cue: true },
  { query: "What is the clinical view I'm studying?", route: "approved_answer", slide: "slide_program", cue: true },
  { query: "What is LIBREXIA STROKE?", route: "approved_answer", slide: "slide_stroke", cue: true },
  { query: "Tell me about LIBREXIA AF.", route: "approved_answer", slide: "slide_af", cue: true },
  { query: "What about ACS?", route: "approved_answer", slide: "slide_acs", cue: true },
  { query: "What is the FDA Fast Track status?", route: "approved_answer", slide: "slide_status", cue: true },
  { query: "Is it FDA approved?", route: "approved_answer", slide: "slide_status", cue: true },
  { query: "Why focus on the clotting cascade rather than the usual path?", route: "approved_answer", slide: "slide_moa", cue: true },
  { query: "How does it work and what is the program?", route: "approved_answer", cue: true },
  { query: "Can you walk me through the approved information?", route: "approved_answer", cue: true },
  { query: "Keep going.", route: "approved_answer", cue: true },
  { query: "Yeah. Sure.", route: "approved_answer", cue: true },
  { query: "Can you summarize that in one sentence?", route: "approved_answer", cue: true },
  { query: "Go back to mechanism.", route: "approved_answer", slide: "slide_moa", cue: true },
  { query: "What should I know safety-wise?", route: "medical_information" },
  { query: "What dose should I use?", route: "medical_information" },
  { query: "Is 25 mg BID the recommended dose?", route: "medical_information" },
  { query: "How does it compare to Eliquis?", route: "medical_information" },
  { query: "Should I prescribe it for my patients?", route: "medical_information" },
  { query: "Can I use it off-label?", route: "off_label_refusal" },
  { query: "A patient had bleeding while on the study drug.", route: "adverse_event" },
  { query: "Can a human representative call me?", route: "human_handoff" },
  { query: "What is limbic syndrome?", route: "fallback" },
  { query: "I was relaxing work.", route: "fallback" },
  { query: "Tell me the latest published efficacy results.", route: "medical_information" },
  { query: "What is Milvexian, and then can you show the program slide?", route: "approved_answer", cue: true },
];

describe.skipIf(process.env.NEXUSREP_RUN_BENCHMARK !== "1")("local turn latency benchmark", () => {
  it("benchmarks the NexusRep turn pipeline without Tavus", async () => {
    // Vitest does not load Next's .env.local. Load it manually for this opt-in benchmark so the
    // numbers match the app's real local runtime (Claude/OpenAI keys, compose mode, etc.).
    for (const file of [".env.local", ".env"]) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m || process.env[m[1]!]) continue;
        process.env[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, "");
      }
    }
    const { createContainer } = await import("@lib/container");
    const { cuesASlide } = await import("@modules/realtime/orchestrator");
    const c = await createContainer({ seedHistory: false });
    const session = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId: c.demo.hcpId });
    const ctxFor = (text: string) => ({
      sessionId: session.id,
      hcpId: c.demo.hcpId,
      audience: c.demo.audience,
      indication: c.demo.indication,
      market: c.demo.market,
      investigational: c.demo.investigational,
      text,
    });

    console.log("[local-turn-benchmark]", JSON.stringify({
      mode: "local-turn-pipeline-no-tavus",
      classifier: process.env.NEXUSREP_CLASSIFIER || "auto",
      compose: process.env.NEXUSREP_COMPOSE || "auto",
      embeddings: process.env.NEXUSREP_EMBEDDINGS || "auto",
    }));

    const rows: { query: string; wallMs: number; route: string; slide: string | null; chars: number; timings: unknown[] }[] = [];
    for (const item of QUERIES) {
      const before = await c.audit.forSession(session.id);
      const beforeSeq = before.reduce((m, e) => Math.max(m, e.seq), -1);
      const started = performance.now();
      const { output } = await c.conversation.turn(ctxFor(item.query), {
        classificationTimeoutMs: 2400,
        composerTimeoutMs: 4000,
        composerMaxTokens: 220,
        speculativeCompose: true,
        suppressRelatedSlide: true,
      });
      const wallMs = Math.round(performance.now() - started);
      const timings = (await c.audit.forSession(session.id))
        .filter((e) => e.seq > beforeSeq)
        .map((e) => ({
          type: e.type,
          action: typeof e.payload.action === "string" ? e.payload.action : undefined,
          latencyMs: typeof e.payload.latencyMs === "number" ? Math.round(e.payload.latencyMs) : undefined,
          wallMs: typeof e.payload.wallMs === "number" ? Math.round(e.payload.wallMs) : undefined,
          fallback: typeof e.payload.fallback === "string" ? e.payload.fallback : undefined,
        }))
        .filter((e) => e.latencyMs !== undefined || e.wallMs !== undefined || e.fallback);
      console.log("[local-turn-benchmark]", JSON.stringify({
        query: item.query,
        wallMs,
        route: output.route,
        decision: output.decision,
        chars: output.responseText.length,
        slide: output.detailAidSlideId ?? null,
        sources: output.sourceIds,
        timings,
      }));
      rows.push({ query: item.query, wallMs, route: output.route, slide: output.detailAidSlideId ?? null, chars: output.responseText.length, timings });
      if (item.route) {
        if (output.route !== item.route) {
          throw new Error(`Route mismatch for "${item.query}": expected ${item.route}, got ${output.route}`);
        }
      }
      if (item.slide && output.detailAidSlideId !== item.slide) {
        throw new Error(`Slide mismatch for "${item.query}": expected ${item.slide}, got ${output.detailAidSlideId ?? "none"}`);
      }
      if (item.cue && !cuesASlide(output.responseText)) {
        throw new Error(`Missing slide cue for "${item.query}": ${output.responseText}`);
      }
    }
    const sorted = rows.map((r) => r.wallMs).sort((a, b) => a - b);
    const p = (n: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * n))] ?? 0;
    console.log("[local-turn-benchmark-summary]", JSON.stringify({
      count: rows.length,
      p50: p(0.5),
      p90: p(0.9),
      p95: p(0.95),
      max: sorted[sorted.length - 1] ?? 0,
      slowest: [...rows].sort((a, b) => b.wallMs - a.wallMs).slice(0, 5).map((r) => ({ query: r.query, wallMs: r.wallMs, route: r.route, slide: r.slide, chars: r.chars })),
    }));
  }, 120_000);
});
