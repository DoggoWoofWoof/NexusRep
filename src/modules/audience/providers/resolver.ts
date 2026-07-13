/**
 * DocNexus code resolver — turns Setup-AI free text (condition/indication names like
 * "atrial fibrillation", "acute coronary syndrome") into canonical ICD-10 diagnosis codes via
 * the platform's autocomplete service, so targeting never depends on AI-guessed codes. Uses the
 * SAME Cognito/API-key auth as the cohort query. Fail-safe: returns [] on any error (the caller
 * keeps whatever the setup already carries) so a resolver hiccup never blocks setup.
 *
 * Empirically (verified against the live service): the autocomplete for
 * `/autocompletes/diagnosis_description?query=atrial%20fibrillation` returns
 * [{codes:["i489"], description:"…atrial fibrillation…"}, …] — lowercase, undotted, SPECIFIC
 * codes. The /api/query claims filter matches codes case-sensitively and exactly (IN), and the
 * warehouse stores them UPPERCASE/undotted, and often at the 3-char category level (e.g. "I48"
 * returns rows). So we emit BOTH the specific code (I489) and its 3-char category (I48) to
 * maximize recall — the same category shape the hand-authored Milvexian query used, now derived
 * from plain-language conditions instead of hardcoded.
 */

import { docnexusAuthHeaders, type DocNexusConfig } from "./docnexus";

const RESOLVER_URL = process.env.DOCNEXUS_RESOLVER_URL ?? "https://advancedsearch.docnexus.ai";

interface AutocompleteHit {
  codes?: string[];
  description?: string;
  name?: string;
}

/** Uppercase + undot an ICD code → { specific, category(3-char) }. */
function normalizeIcd(code: string): { specific: string; category: string } | null {
  const norm = code.trim().toUpperCase().replace(/\./g, "");
  if (!norm) return null;
  return { specific: norm, category: norm.slice(0, 3) };
}

/**
 * Resolve free-text condition/indication terms to canonical ICD-10 codes. Returns 3-char
 * CATEGORY codes first (one per condition, broad recall, cheap to query), then the specific
 * codes — so a downstream cap (the query keeps only the first N codes) preserves cross-condition
 * coverage instead of spending its whole budget on the first term. `perTerm` caps autocomplete
 * hits kept per term (default 2). Fail-safe: a term that errors is simply skipped.
 */
export async function resolveDiagnosisCodes(
  terms: string[],
  config: DocNexusConfig,
  opts?: { perTerm?: number },
): Promise<string[]> {
  const clean = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
  if (!clean.length) return [];
  const headers = await docnexusAuthHeaders(config).catch(() => ({ "Content-Type": "application/json" }));
  const perTerm = Math.max(1, opts?.perTerm ?? 2);
  const categories = new Set<string>();
  const specifics = new Set<string>();

  await Promise.all(
    clean.map(async (term) => {
      try {
        const url = `${RESOLVER_URL.replace(/\/$/, "")}/autocompletes/diagnosis_description?query=${encodeURIComponent(term)}&limit=8&skip=0`;
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return;
        const json = (await res.json()) as { result?: { _source?: AutocompleteHit }[] };
        const hits = (json.result ?? []).map((r) => r._source).filter((h): h is AutocompleteHit => Boolean(h));
        let taken = 0;
        for (const hit of hits) {
          for (const code of hit.codes ?? []) {
            const n = normalizeIcd(code);
            if (!n) continue;
            categories.add(n.category);
            if (n.specific !== n.category) specifics.add(n.specific);
          }
          if (++taken >= perTerm) break;
        }
      } catch {
        /* fail-safe: skip this term, keep resolving the others */
      }
    }),
  );

  return [...categories, ...specifics];
}
