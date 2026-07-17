"use client";

/**
 * Client-side activity capture: records EVERY click, navigation, and API call the browser makes and
 * beacons them (batched) to /api/activity/ingest, so the Admin → Activity dashboard shows what a user
 * is doing live — without the host console. Best-effort and self-contained: it never blocks the UI and
 * silently drops on failure.
 *
 * Mounted once per surface (brand console + doctor view). The acting user is stamped server-side at
 * ingest; here we only tag which surface the events came from.
 */

type Surface = "brand" | "doctor";

interface Beacon {
  category: string;
  action: string;
  target?: string;
  sessionId?: string;
  severity?: string;
  metadata?: Record<string, unknown>;
  at: string;
}

let queue: Beacon[] = [];
let flushTimer: number | null = null;
let installed = false;
let surface: Surface = "brand";
let sessionIdFn: (() => string | undefined) | undefined;
// The REAL fetch, captured before we patch window.fetch — used to send beacons so the beacon POST
// isn't itself logged (which would loop forever).
let origFetch: typeof fetch | null = null;

function pathOf(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url;
  }
}

function scheduleFlush(): void {
  if (flushTimer == null) flushTimer = window.setTimeout(flush, 1000);
}

function flush(): void {
  flushTimer = null;
  if (!queue.length) return;
  const batch = queue.slice(0, 60);
  queue = queue.slice(batch.length);
  const send = origFetch ?? window.fetch;
  try {
    void send("/api/activity/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: batch, surface }),
      keepalive: true, // survive a tab close so the last clicks still land (batch is small JSON)
    }).catch(() => undefined);
  } catch {
    /* dropped */
  }
  if (queue.length) scheduleFlush();
}

/** Queue one event (used by the interceptors below and by explicit callers e.g. logNavigation). */
export function logClientActivity(ev: Omit<Beacon, "at">): void {
  if (queue.length > 800) queue.shift(); // bound memory if the network is down
  queue.push({ ...ev, at: new Date().toISOString() });
  scheduleFlush();
}

/** Explicit navigation event (SPA screen change) — called from the nav handler. */
export function logNavigation(to: string, from?: string): void {
  logClientActivity({ category: "navigation", action: "Navigated", target: to, metadata: from ? { from } : undefined });
}

function clickLabel(el: Element | null): string {
  let n: Element | null = el;
  for (let i = 0; i < 4 && n; i += 1) {
    const da = n.getAttribute?.("data-activity");
    if (da) return da;
    const aria = n.getAttribute?.("aria-label");
    if (aria) return aria.trim().slice(0, 60);
    if (n.tagName === "BUTTON" || n.tagName === "A" || n.getAttribute?.("role") === "button") {
      const t = (n.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
      if (t) return t;
    }
    n = n.parentElement;
  }
  const t = (el?.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
  return t || el?.tagName?.toLowerCase() || "unknown";
}

/**
 * Install capture for a surface. Returns a cleanup fn. Idempotent (a second call is a no-op) so
 * React StrictMode's double-invoke or a re-mount doesn't stack patches/listeners.
 */
export function installActivityCapture(opts: { surface: Surface; sessionId?: () => string | undefined }): () => void {
  if (installed || typeof window === "undefined") return () => undefined;
  installed = true;
  surface = opts.surface;
  sessionIdFn = opts.sessionId;

  // 1) Every API call — patch window.fetch, but never log the beacon endpoint (would loop).
  origFetch = window.fetch.bind(window);
  const patched: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method || (input instanceof Request ? input.method : "GET") || "GET").toUpperCase();
    const track = url.includes("/api/") && !url.includes("/api/activity");
    const t0 = performance.now();
    try {
      const res = await origFetch!(input as RequestInfo, init);
      if (track) {
        logClientActivity({
          category: "api",
          action: `${method} ${pathOf(url)}`,
          target: pathOf(url),
          sessionId: sessionIdFn?.(),
          severity: res.ok ? "info" : res.status >= 500 ? "error" : "warn",
          metadata: { status: res.status, ms: Math.round(performance.now() - t0) },
        });
      }
      return res;
    } catch (err) {
      if (track) {
        logClientActivity({
          category: "api",
          action: `${method} ${pathOf(url)}`,
          target: pathOf(url),
          sessionId: sessionIdFn?.(),
          severity: "error",
          metadata: { error: String(err), ms: Math.round(performance.now() - t0) },
        });
      }
      throw err;
    }
  };
  window.fetch = patched;

  // 2) Every click — capture phase so it fires even when a handler stops propagation.
  const onClick = (e: MouseEvent): void => {
    logClientActivity({
      category: "click",
      action: "Clicked",
      target: clickLabel(e.target as Element | null),
      sessionId: sessionIdFn?.(),
    });
  };
  document.addEventListener("click", onClick, true);

  return () => {
    document.removeEventListener("click", onClick, true);
    if (origFetch && window.fetch === patched) window.fetch = origFetch;
    installed = false;
    flush();
  };
}
