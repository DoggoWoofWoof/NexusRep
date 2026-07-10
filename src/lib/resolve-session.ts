/**
 * Shared session + HCP-identity resolution for every conversation-shaped route
 * (conversation/turn, presentation/step, presentation/overview, tavus/conversation).
 * One implementation so the routes can never drift apart (they previously each
 * carried their own copy of this logic).
 *
 * Identity: the invite link carries the doctor's cohort id (/hcp?hcp=<id>). A supplied
 * hcpId is honored ONLY when it resolves to a real targeted HCP in the claims cohort —
 * an unknown id falls back to the demo HCP, never inventing an identity. A continuing
 * session keeps the identity it started with (turns can't be re-attributed).
 */

import { asId, type HcpId, type SessionId } from "./ids";
import type { AppContainer } from "./container";

export interface SessionResolveInput {
  sessionId?: unknown;
  newSession?: unknown;
  greeting?: unknown;
  hcpId?: unknown;
}

export interface SessionResolution {
  sessionId: SessionId;
  hcpId: HcpId;
}

export async function resolveSessionAndHcp(c: AppContainer, body: SessionResolveInput): Promise<SessionResolution> {
  const greeting = typeof body.greeting === "string" ? body.greeting.trim() : "";
  // Canonicalize through the cohort: UI surfaces pass stripped ids (the drawer and invite
  // links drop the "hcp_" prefix), which previously failed the lookup and silently
  // attributed the session to the demo doctor. The session stores the COHORT's id.
  const member = typeof body.hcpId === "string" ? c.targeting.get(body.hcpId) : undefined;
  const invitedHcp = member ? (asId<"hcp_id">(String(member.id)) as HcpId) : undefined;
  const requested = typeof body.sessionId === "string" ? (asId<"session_id">(body.sessionId) as SessionId) : undefined;

  let hcpId: HcpId = invitedHcp ?? c.demo.hcpId;
  const existing = requested ? await c.sessions.get(requested) : null;
  if (requested && existing) {
    return { sessionId: requested, hcpId: existing.hcpId };
  }
  if (body.newSession === true) {
    const fresh = await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId });
    // Log the rep's opening greeting as turn 0 so it's in the transcript (not just the
    // live caption). Video sessions get it from the replica utterance instead.
    if (greeting) await c.sessions.appendTurn(fresh.id, { speaker: "rep", text: greeting });
    return { sessionId: fresh.id, hcpId };
  }
  // Shared demo session, opened lazily (always the demo HCP).
  hcpId = c.demo.hcpId;
  if (!(await c.sessions.get(c.demo.sessionId))) {
    await c.conversation.start({ aiRepId: c.demo.aiRepId, hcpId, seed: "demo" });
  }
  return { sessionId: c.demo.sessionId, hcpId };
}
