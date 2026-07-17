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
    case "admin": return <Admin />;
    case "activity": return <ActivityDashboard />;
    default: return null;
  }
}
