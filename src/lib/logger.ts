/**
 * Structured logger — one dependency-free, node-first logger replacing scattered raw console.*.
 *
 *  - Levels debug < info < warn < error, gated by env.logLevel.
 *  - env.logFormat "json" → one JSON object per line (prod: parseable by Render/any log aggregator);
 *    "pretty" → human-readable colored lines (local dev). Defaults by NODE_ENV.
 *  - logger.child("scope") binds a scope tag, mirroring the existing "[scope]" prefix convention.
 *  - NO redaction: fields are logged verbatim. These are OUR logs — full HCP transcripts/answers are
 *    intentionally kept here for debugging. (The "no patient data to third parties" rule is enforced
 *    separately, at the vendor boundary — see lib/pii-redact.ts — NOT here.)
 *
 * Observability must never break the flow it observes: emit() swallows its own errors.
 */

import { env } from "./env";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;
const threshold = LEVELS[env.logLevel];

export type LogFields = Record<string, unknown>;

/** JSON.stringify that survives circular refs and serializes Error objects (message + stack + own
 *  enumerable props) instead of emitting "{}" for them. */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack, ...(val as unknown as LogFields) };
    }
    if (typeof val === "bigint") return val.toString();
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}

const COLORS: Record<LogLevel, string> = { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" };
const RESET = "\x1b[0m";

function emit(level: LogLevel, scope: string | undefined, msg: string, fields?: LogFields): void {
  if (LEVELS[level] < threshold) return;
  try {
    const ts = new Date().toISOString();
    if (env.logFormat === "json") {
      const line = safeStringify({ ts, level, ...(scope ? { scope } : {}), msg, ...fields });
      if (typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function") {
        process.stdout.write(line + "\n");
      } else {
        console.log(line);
      }
      return;
    }
    // pretty (dev)
    const head = `\x1b[90m${ts}${RESET} ${COLORS[level]}${level.toUpperCase().padEnd(5)}${RESET} ${scope ? `[${scope}] ` : ""}${msg}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (fields && Object.keys(fields).length) fn(head, fields);
    else fn(head);
  } catch {
    /* logging must never throw into the caller's flow */
  }
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Return a logger that tags every line with this scope (e.g. "tavus-llm"). */
  child(scope: string): Logger;
}

function make(scope?: string): Logger {
  return {
    debug: (msg, fields) => emit("debug", scope, msg, fields),
    info: (msg, fields) => emit("info", scope, msg, fields),
    warn: (msg, fields) => emit("warn", scope, msg, fields),
    error: (msg, fields) => emit("error", scope, msg, fields),
    child: (childScope) => make(scope ? `${scope}:${childScope}` : childScope),
  };
}

export const logger: Logger = make();
