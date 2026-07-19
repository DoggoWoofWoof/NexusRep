/**
 * Cache hit/miss telemetry — a tiny process-global registry so the admin Usage view can show how
 * often each cache SAVES a paid vendor call. A TTS cache hit means a repeated line (greeting, ISI) is
 * served from memory for $0 instead of a real OpenAI generation; the hit rate is money not spent.
 *
 * Single-instance (render numInstances:1), like the usage ledger + activity log; in-memory, resets on
 * restart. Every writer is best-effort and never throws — observability must not break the flow it
 * observes. "miss" is recorded at the point a real (billable) generation happens, so hit rate reads as
 * "share of cacheable requests served free", not polluted by no-key 204s that never had a clip to cache.
 */

interface CacheCounter {
  hits: number;
  misses: number;
  /** Optional live entry-count probe (e.g. () => map.size). */
  size?: () => number;
}

const g = globalThis as unknown as { __nexusrepCacheStats?: Map<string, CacheCounter> };
function store(): Map<string, CacheCounter> {
  if (!g.__nexusrepCacheStats) g.__nexusrepCacheStats = new Map();
  return g.__nexusrepCacheStats;
}
function counter(name: string): CacheCounter {
  const s = store();
  let c = s.get(name);
  if (!c) {
    c = { hits: 0, misses: 0 };
    s.set(name, c);
  }
  return c;
}

/** Register a live size probe so the snapshot can show how many entries a cache is holding. */
export function registerCacheSize(name: string, size: () => number): void {
  try { counter(name).size = size; } catch { /* never break the caller */ }
}
export function recordCacheHit(name: string): void {
  try { counter(name).hits += 1; } catch { /* never break the caller */ }
}
export function recordCacheMiss(name: string): void {
  try { counter(name).misses += 1; } catch { /* never break the caller */ }
}

export interface CacheStat {
  name: string;
  hits: number;
  misses: number;
  total: number;
  hitRate: number; // 0..1 — share of cacheable requests served from cache
  entries: number | null; // current size when a probe is registered
}

export function cacheStatsSnapshot(): CacheStat[] {
  return [...store().entries()]
    .map(([name, c]): CacheStat => {
      const total = c.hits + c.misses;
      return { name, hits: c.hits, misses: c.misses, total, hitRate: total ? c.hits / total : 0, entries: c.size ? c.size() : null };
    })
    .sort((a, b) => b.total - a.total);
}

/** Test-only reset. */
export function __resetCacheStatsForTests(): void {
  store().clear();
}
