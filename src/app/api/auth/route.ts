/**
 * Brand-console auth — thin controller. A shared password (NEXUSREP_APP_PASSWORD) unlocks the
 * console and sets a signed, httpOnly session cookie. OFF when no password is configured, so
 * local/E2E stay open. The doctor link (/hcp) and the runtime turn / presentation / realtime
 * endpoints it uses are intentionally NOT gated — doctors reach the rep by link, not by login.
 */

import { NextRequest, NextResponse } from "next/server";
import { appAuthEnabled, cookieIsValid, passwordMatches, sessionToken, SESSION_COOKIE } from "@lib/auth-session";

export const dynamic = "force-dynamic";

/** Session status — the client gate reads this to decide whether to show the login screen. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({
    enabled: appAuthEnabled(),
    authed: cookieIsValid(req.cookies.get(SESSION_COOKIE)?.value),
  });
}

/** { action: "login", password } → set the session cookie; { action: "logout" } → clear it. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; password?: unknown };

  if (body.action === "logout") {
    const res = NextResponse.json({ ok: true, authed: false });
    res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  // Gate disabled → nothing to unlock.
  if (!appAuthEnabled()) return NextResponse.json({ ok: true, authed: true, enabled: false });

  if (typeof body.password === "string" && passwordMatches(body.password)) {
    const res = NextResponse.json({ ok: true, authed: true });
    res.cookies.set(SESSION_COOKIE, sessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // one week
      secure: process.env.NODE_ENV === "production", // http on localhost, https on Render
    });
    return res;
  }

  return NextResponse.json({ ok: false, authed: false, error: "Incorrect password." }, { status: 401 });
}
