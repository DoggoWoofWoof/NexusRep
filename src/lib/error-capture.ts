/**
 * Central error capture. Two jobs the app lacked:
 *   1. Errors swallowed into the per-session audit trail (composer/classifier/retrieval fallbacks in
 *      the orchestrator) or re-thrown from the Tavus route were invisible in stdout — an LLM/vendor
 *      outage left NO operational signal. captureError() gives every one a structured error log.
 *   2. Unhandled rejections / uncaught exceptions had zero capture path. instrumentation.ts wires the
 *      process handlers to this.
 *
 * Default sink is our own structured logger (full content — see logger.ts). An external tracker
 * (Sentry/Datadog/…) is OPT-IN via registerErrorSink() so we take on NO third-party dependency by
 * default and nothing leaves our infrastructure unless the operator wires it.
 */

import { logger } from "./logger";
import { env } from "./env";

export type ErrorContext = Record<string, unknown> & {
  /** Where it happened, e.g. "orchestrator.compose" — becomes the log message when set. */
  phase?: string;
};

export type ErrorSink = (error: Error, context?: ErrorContext) => void;

let externalSink: ErrorSink | null = null;

/** Register an external error tracker (e.g. Sentry). Called from instrumentation.ts at boot when
 *  the operator has wired one. captureError still always logs on our side first. */
export function registerErrorSink(sink: ErrorSink): void {
  externalSink = sink;
}

export function hasExternalSink(): boolean {
  return externalSink !== null;
}

function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}

/**
 * Record an error: ALWAYS a structured error log on our side (full error + context), THEN forward to
 * the external sink if one is registered. Never throws — observability must not break the flow it
 * observes.
 */
export function captureError(err: unknown, context?: ErrorContext): void {
  const error = toError(err);
  const { phase, ...rest } = context ?? {};
  logger.error(phase ? `error in ${phase}` : error.message, { ...rest, ...(phase ? { phase } : {}), error });
  if (externalSink) {
    try {
      externalSink(error, context);
    } catch {
      /* a broken tracker must never take down the request */
    }
  }
}

/** Log once at boot if a Sentry DSN is configured but no sink was wired, so the intent isn't silently
 *  dropped. (We ship no Sentry dependency; wire it via registerErrorSink.) */
export function warnIfUnwiredTracker(): void {
  if (env.sentryDsn && !externalSink) {
    logger.warn("NEXUSREP_SENTRY_DSN is set but no error sink is registered — errors are structured-logged only; call registerErrorSink() to forward them", { scope: "error-capture" });
  }
}
