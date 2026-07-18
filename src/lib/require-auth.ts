/**
 * Server-side authorization for the BRAND-CONSOLE API routes. Until now the login was a client-only
 * screen (it renders <Login> but every /api route ran ungated), so `curl /api/sessions|studio|…`
 * returned/mutated brand data unauthenticated. `requireBrandUser()` closes that: each brand route
 * calls it and returns the 401/503 response when it's not `ok`.
 *
 * Deliberately scoped: this guards ONLY the brand console. The public doctor path
 * (/api/conversation/turn, /api/presentation/*, /api/realtime/*), the cookie-less Tavus custom-LLM
 * callback (/api/tavus/*), the recording ingest, and /api/brand are NEVER gated here — so the per-user
 * live Tavus session isolation is untouched.
 *
 * No-op when auth is disabled (NEXUSREP_AUTH=0 — local dev / E2E / unit tests), so those keep driving
 * the console directly. Identity is the SAME signed-cookie username the per-user container resolves
 * (currentUserId), so a request is authorized iff it owns a valid session cookie.
 */

import { NextResponse } from "next/server";
import { appAuthEnabled, isAdminUser } from "@lib/auth-session";
import { currentUserId } from "@lib/container";
import { env } from "@lib/env";

/** A real (auth-enabled) production deploy still using the PUBLIC default cookie secret → cookies are
 *  forgeable. Refuse brand data rather than trust a forgeable session. */
function sessionSecretMisconfigured(): boolean {
  return process.env.NODE_ENV === "production" && appAuthEnabled() && env.sessionSecretIsDefault;
}

export type BrandAuth = { ok: true; user: string } | { ok: false; res: NextResponse };

export async function requireBrandUser(): Promise<BrandAuth> {
  if (sessionSecretMisconfigured()) {
    return {
      ok: false,
      res: NextResponse.json(
        { error: "server auth is misconfigured: set NEXUSREP_SESSION_SECRET (or NEXUSREP_AUTH=0)" },
        { status: 503 },
      ),
    };
  }
  if (!appAuthEnabled()) return { ok: true, user: "local" }; // auth off → open (dev / E2E / tests)
  const user = await currentUserId();
  if (!user) return { ok: false, res: NextResponse.json({ error: "authentication required" }, { status: 401 }) };
  return { ok: true, user };
}

/**
 * Like requireBrandUser, but additionally requires the ADMIN role — the gate for the internal
 * oversight surfaces (Platform Admin `/api/integrations`, the cross-user Activity monitor
 * `/api/activity`). A signed-in non-admin gets 403 (authenticated but not authorized). When auth is
 * OFF (dev / E2E / tests) it's open, same as requireBrandUser, so those flows keep full access.
 */
export async function requireAdminUser(): Promise<BrandAuth> {
  const base = await requireBrandUser();
  if (!base.ok) return base; // 503 (misconfig) or 401 (no session) already handled
  if (!appAuthEnabled()) return base; // auth off → open (base.user === "local")
  if (!isAdminUser(base.user)) {
    return { ok: false, res: NextResponse.json({ error: "administrator access required" }, { status: 403 }) };
  }
  return base;
}
