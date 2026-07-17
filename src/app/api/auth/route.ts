/**
 * Brand-console auth — thin controller. A small fixed demo directory (auth-session.ts): each
 * user signs in with a username + password and gets their OWN isolated container. OFF when the
 * gate is disabled, so local/E2E stay open. The doctor link (/hcp) and the runtime turn /
 * presentation / realtime endpoints it uses are intentionally NOT gated.
 */

import { NextRequest, NextResponse } from "next/server";
import { appAuthEnabled, verifyCredentials, sessionCookieFor, usernameFromCookie, findUser, SESSION_COOKIE } from "@lib/auth-session";
import { recordActivity } from "@modules/activity";

export const dynamic = "force-dynamic";

/** Session status — the client gate reads this to decide whether to show the login screen. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const username = usernameFromCookie(req.cookies.get(SESSION_COOKIE)?.value);
  const user = username ? findUser(username) : undefined;
  return NextResponse.json({
    enabled: appAuthEnabled(),
    authed: Boolean(user),
    username: user?.username ?? null,
    name: user?.name ?? null,
  });
}

/** { action:"login", username, password } → set the session cookie; { action:"logout" } → clear. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; username?: unknown; password?: unknown };

  if (body.action === "logout") {
    const who = usernameFromCookie(req.cookies.get(SESSION_COOKIE)?.value);
    recordActivity({ user: who ?? "anon", surface: "brand", category: "auth", action: "Signed out" });
    const res = NextResponse.json({ ok: true, authed: false });
    res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  if (!appAuthEnabled()) return NextResponse.json({ ok: true, authed: true, enabled: false });

  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const user = verifyCredentials(username, password);
  if (user) {
    recordActivity({ user: user.username, surface: "brand", category: "auth", action: "Signed in", metadata: { name: user.name } });
    const res = NextResponse.json({ ok: true, authed: true, username: user.username, name: user.name });
    res.cookies.set(SESSION_COOKIE, sessionCookieFor(user.username), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7, // one week
      secure: process.env.NODE_ENV === "production",
    });
    return res;
  }

  recordActivity({ user: username || "anon", surface: "brand", category: "auth", action: "Failed sign-in", severity: "warn", metadata: { username } });
  return NextResponse.json({ ok: false, authed: false, error: "Incorrect username or password." }, { status: 401 });
}
