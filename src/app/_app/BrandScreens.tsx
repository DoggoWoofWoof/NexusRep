"use client";

/**
 * Thin dispatcher for the brand-console governance screens. Each screen lives in its own file
 * (Audience/Launch/Sessions/Analytics/SessionDetail/FollowUps/Admin + the shared useAudience hook);
 * this only maps the active nav to the screen. Overview + AI Rep (Studio) are routed in NexusRepApp.
 */

import type { AppState } from "./NexusRepApp";
import { ActivityDashboard } from "./ActivityDashboard";
import { Audience } from "./Audience";
import { Launch } from "./Launch";
import { Sessions } from "./Sessions";
import { Analytics } from "./Analytics";
import { SessionDetail } from "./SessionDetail";
import { FollowUps } from "./FollowUps";
import { Admin } from "./Admin";

export function BrandScreens({ app }: { app: AppState }) {
  switch (app.nav) {
    case "targeting": return <Audience app={app} />;
    case "outreach": return <Launch app={app} />;
    case "sessions": return <Sessions app={app} />;
    case "analytics": return <Analytics />;
    case "audit": return <SessionDetail app={app} />;
    case "crm": return <FollowUps />;
    // Internal oversight surfaces — admins only (the server also enforces this via requireAdminUser,
    // so this is defense-in-depth + UX, not the security boundary).
    case "admin": return app.isAdmin ? <Admin /> : <NotAuthorized />;
    case "activity": return app.isAdmin ? <ActivityDashboard /> : <NotAuthorized />;
    default: return null;
  }
}

/** Shown if a non-admin's nav state somehow lands on an admin-only screen (the nav entries are hidden
 *  for them, so this is a fallback). Deliberately plain — no internal detail leaked. */
function NotAuthorized() {
  return (
    <div style={{ padding: "48px 28px", font: "500 13px/1.5 var(--dn-font-sans)", color: "var(--dn-fg-muted)" }}>
      This area is restricted to administrators.
    </div>
  );
}
