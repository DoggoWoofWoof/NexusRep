/**
 * Client helper to stream a provider's answer from /api/arena/stream, calling
 * onToken as tokens arrive and returning latency metrics. Used by the in-chat
 * A/B model comparison.
 */

export interface ArenaResult {
  ttftMs: number;
  totalMs: number;
  chars: number;
  error?: string;
}

export async function streamArena(opts: {
  provider: string;
  text: string;
  signal?: AbortSignal;
  onToken: (t: string) => void;
}): Promise<ArenaResult> {
  const t0 = Date.now();
  let ttft = -1;
  let chars = 0;
  const res = await fetch("/api/arena/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: opts.provider, text: opts.text }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    return { ttftMs: 0, totalMs: Date.now() - t0, chars: 0, error: j.error || `HTTP ${res.status}` };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let error: string | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const evt = JSON.parse(line.slice(5).trim()) as
        | { type: "token"; t: string }
        | { type: "done"; metrics: { chars: number } }
        | { type: "error"; message: string };
      if (evt.type === "token") {
        if (ttft < 0) ttft = Date.now() - t0;
        chars += evt.t.length;
        opts.onToken(evt.t);
      } else if (evt.type === "error") {
        error = evt.message;
      }
    }
  }
  return { ttftMs: ttft < 0 ? 0 : ttft, totalMs: Date.now() - t0, chars, error };
}
