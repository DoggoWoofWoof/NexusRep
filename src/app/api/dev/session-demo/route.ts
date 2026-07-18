/**
 * Local-only helpers for building a clean showcase session.
 * This route is intentionally disabled in production. It lets a local script clear
 * session-side demo rows and attach a generated playback file to a real session
 * without adding admin controls to the product UI.
 */

import { NextResponse } from "next/server";
import { currentUserId, getContainer } from "@lib/container";
import { getActiveSqlHandle } from "@lib/db";
import { env } from "@lib/env";
import { asId, newId } from "@lib/ids";
import type { ConversationSession, ConversationTurn } from "@modules/sessions";
import type { AuditRecord } from "@modules/audit";
import type { FollowUpTask, FollowUpType } from "@modules/followups";

export const dynamic = "force-dynamic";

function ident(name: string): string {
  return `"${name.replace(/[^a-zA-Z0-9_]/g, "_")}"`;
}

function userPrefix(userId: string | null): string {
  return userId ? `u_${userId.toLowerCase().replace(/[^a-z0-9]/g, "_")}_` : "";
}

/** True when canonical state actually persists across restarts (managed node-pg OR embedded PGlite).
 *  On the memory driver these dev helpers are a no-op — a restart already resets everything. */
function persistent(): boolean {
  return Boolean(env.databaseUrl) || env.dataDriver === "postgres";
}

function restoredFollowUpOwner(type: FollowUpType): string {
  switch (type) {
    case "msl":
    case "medical_information":
      return "Medical Information";
    case "pharmacovigilance":
      return "Pharmacovigilance";
    case "human_rep":
      return "Field Rep";
  }
}

function isFollowUpType(value: unknown): value is FollowUpType {
  return value === "human_rep" || value === "msl" || value === "medical_information" || value === "pharmacovigilance";
}

async function ensureAndClear(table: string): Promise<number> {
  if (env.dataDriver === "postgres" && !env.databaseUrl && !process.env.PGLITE_DATA_DIR) process.env.PGLITE_DATA_DIR = ".nexusrep-data";
  const db = await getActiveSqlHandle();
  await db.exec(`create table if not exists ${ident(table)} (ord bigserial, id text primary key, data text not null)`);
  const res = await db.query(`delete from ${ident(table)}`);
  return res.affectedRows ?? 0;
}

export async function POST(req: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    sessionId?: unknown;
    recordingUrl?: unknown;
    durationSeconds?: unknown;
    timelineStartedAt?: unknown;
    turnOffsetsSeconds?: unknown;
    turnTextOverrides?: unknown;
    detail?: unknown;
  };

  if (body.action === "clean") {
    if (!persistent()) {
      return NextResponse.json({ ok: true, cleaned: {}, note: "memory driver resets on restart" });
    }
    const prefix = userPrefix(await currentUserId());
    const tables = ["sessions", "audit", "followups", "crm_outbox"].map((t) => `${prefix}${t}`);
    const cleaned: Record<string, number> = {};
    for (const table of tables) cleaned[table] = await ensureAndClear(table);
    return NextResponse.json({ ok: true, cleaned });
  }

  if (body.action === "attachRecording") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const recordingUrl = typeof body.recordingUrl === "string" ? body.recordingUrl.trim() : "";
    const durationSeconds = typeof body.durationSeconds === "number" && Number.isFinite(body.durationSeconds)
      ? Math.max(0, Math.round(body.durationSeconds))
      : undefined;
    if (!sessionId || !recordingUrl) {
      return NextResponse.json({ error: "sessionId and recordingUrl required" }, { status: 400 });
    }
    const c = await getContainer();
    const sid = asId<"session_id">(sessionId);
    const vendorId = `local_recording_${sessionId}`;
    await c.sessions.setVendorConversation(sid, vendorId);
    if (durationSeconds !== undefined) await c.sessions.end(sid, { durationSeconds });
    const attached = await c.sessions.attachRecording(vendorId, recordingUrl);
    if (!attached) return NextResponse.json({ error: "session not found" }, { status: 404 });
    return NextResponse.json({ ok: true, sessionId: attached.id, recordingUrl: attached.recordingUrl ?? null, durationSeconds: attached.durationSeconds });
  }

  if (body.action === "importSessionDetail") {
    if (!persistent()) {
      return NextResponse.json({ error: "importSessionDetail requires the local postgres driver" }, { status: 400 });
    }
    const detail = body.detail as {
      session?: { id?: string; startedAt?: string; durationSeconds?: number; questionCount?: number; complianceStatus?: ConversationSession["complianceStatus"]; recordingUrl?: string | null };
      turns?: { speaker?: "hcp" | "rep"; text?: string; sourceIds?: string[]; detailAidSlideId?: string | null; at?: string | null }[];
      audit?: { seq?: number; type?: AuditRecord["type"]; payload?: Record<string, unknown> }[];
    } | null;
    const sidRaw = detail?.session?.id;
    if (!sidRaw || !detail?.session?.startedAt) return NextResponse.json({ error: "detail.session.id and startedAt required" }, { status: 400 });
    const c = await getContainer();
    const sid = asId<"session_id">(sidRaw);
    const turns = (detail.turns ?? []).map((turn, index) => ({
      id: newId<"turn_id">("turn", `${sidRaw}_restore_${index}`),
      sessionId: sid,
      speaker: turn.speaker === "hcp" ? "hcp" : "rep",
      text: String(turn.text ?? ""),
      sourceIds: Array.isArray(turn.sourceIds) ? turn.sourceIds : [],
      ...(turn.detailAidSlideId ? { detailAidSlideId: turn.detailAidSlideId } : {}),
      ...(turn.at ? { at: turn.at } : {}),
    })) satisfies ConversationTurn[];
    const session: ConversationSession = {
      id: sid,
      aiRepId: c.demo.aiRepId,
      hcpId: c.demo.hcpId,
      startedAt: detail.session.startedAt,
      durationSeconds: Math.max(0, Math.round(detail.session.durationSeconds ?? 0)),
      questionCount: turns.filter((t) => t.speaker === "hcp").length,
      complianceStatus: detail.session.complianceStatus ?? "approved",
      turns,
      ...(detail.session.recordingUrl ? { recordingUrl: detail.session.recordingUrl } : {}),
      timelineSource: "recorded",
    };
    const prefix = userPrefix(await currentUserId());
    const db = await getActiveSqlHandle();
    const sessionTable = `${prefix}sessions`;
    const auditTable = `${prefix}audit`;
    const followupsTable = `${prefix}followups`;
    await ensureAndClear(sessionTable);
    await ensureAndClear(auditTable);
    await ensureAndClear(followupsTable);
    await db.query(`insert into ${ident(sessionTable)} (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data`, [session.id, JSON.stringify(session)]);
    for (const [index, event] of (detail.audit ?? []).entries()) {
      const rec: AuditRecord = {
        id: newId<"audit_event_id">("aud", `${sidRaw}_restore_${index}`),
        sessionId: sid,
        type: event.type ?? "response_output",
        seq: typeof event.seq === "number" ? event.seq : index,
        payload: event.payload ?? {},
      };
      await db.query(`insert into ${ident(auditTable)} (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data`, [rec.id, JSON.stringify(rec)]);
      const type = event.type === "follow_up_created" && isFollowUpType(event.payload?.type) ? event.payload.type : null;
      if (type) {
        const followUp: FollowUpTask = {
          id: asId<"follow_up_task_id">(typeof event.payload?.followUpId === "string" ? event.payload.followUpId : newId("fu", `${sidRaw}_restore_fu_${index}`)),
          hcpId: c.demo.hcpId,
          type,
          owner: restoredFollowUpOwner(type),
          status: "created",
          dueAt: null,
          sourceSessionId: sid,
        };
        await db.query(`insert into ${ident(followupsTable)} (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data`, [followUp.id, JSON.stringify(followUp)]);
      }
    }
    return NextResponse.json({ ok: true, sessionId: session.id, turns: turns.length, audit: detail.audit?.length ?? 0 });
  }

  if (body.action === "resequence") {
    if (!persistent()) {
      return NextResponse.json({ error: "resequence requires the local postgres driver" }, { status: 400 });
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const durationSeconds = typeof body.durationSeconds === "number" && Number.isFinite(body.durationSeconds)
      ? Math.max(1, Math.round(body.durationSeconds))
      : undefined;
    const exactOffsets = Array.isArray(body.turnOffsetsSeconds)
      ? body.turnOffsetsSeconds.map((v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : null))
      : null;
    const textOverrides = Array.isArray(body.turnTextOverrides)
      ? body.turnTextOverrides.map((v) => (typeof v === "string" && v.trim() ? v.trim() : null))
      : null;
    const timelineStartedAt = typeof body.timelineStartedAt === "string" && Number.isFinite(Date.parse(body.timelineStartedAt))
      ? new Date(body.timelineStartedAt).toISOString()
      : undefined;
    if (!sessionId) return NextResponse.json({ error: "sessionId required" }, { status: 400 });

    const prefix = userPrefix(await currentUserId());
    const table = `${prefix}sessions`;
    const db = await getActiveSqlHandle();
    const r = await db.query<{ data: string }>(`select data from ${ident(table)} where id = $1`, [sessionId]);
    const row = r.rows[0];
    if (!row) return NextResponse.json({ error: "session not found" }, { status: 404 });

    const session = JSON.parse(row.data) as ConversationSession;
    const startedAt = timelineStartedAt ?? session.startedAt;
    const turns = exactOffsets?.length
      ? exactTimelineTurns(session.turns, startedAt, exactOffsets, textOverrides)
      : resequenceTurns(session.turns, startedAt, durationSeconds ?? session.durationSeconds);
    const lastAt = turns.at(-1)?.at;
    const spanSeconds = lastAt ? Math.max(0, Math.round((Date.parse(lastAt) - Date.parse(startedAt)) / 1000)) : 0;
    const next: ConversationSession = {
      ...session,
      startedAt,
      turns,
      durationSeconds: Math.max(durationSeconds ?? session.durationSeconds, spanSeconds),
      questionCount: turns.filter((t) => t.speaker === "hcp").length,
      ...(exactOffsets?.length ? { timelineSource: "recorded" as const } : {}),
    };
    await db.query(`update ${ident(table)} set data = $2 where id = $1`, [sessionId, JSON.stringify(next)]);
    return NextResponse.json({
      ok: true,
      sessionId: next.id,
      durationSeconds: next.durationSeconds,
      firstTurnAt: turns[0]?.at ?? null,
      lastTurnAt: turns.at(-1)?.at ?? null,
    });
  }

  return NextResponse.json({ error: "unknown action" }, { status: 400 });
}

function turnSeconds(turn: ConversationTurn): number {
  const words = turn.text.trim().split(/\s+/).filter(Boolean).length;
  if (turn.speaker === "hcp") return Math.min(7, Math.max(2.2, words / 3.2));
  return Math.min(32, Math.max(2.5, words / 2.5));
}

function resequenceTurns(turns: ConversationTurn[], startedAt: string, targetDurationSeconds?: number): ConversationTurn[] {
  if (!turns.length) return turns;
  const baseOffsets: number[] = [];
  let cursor = 0;
  for (const turn of turns) {
    baseOffsets.push(cursor);
    cursor += turnSeconds(turn) + (turn.speaker === "hcp" ? 0.75 : 1.05);
  }
  const baseEnd = cursor;
  const targetEnd = targetDurationSeconds && targetDurationSeconds > 0 ? targetDurationSeconds : baseEnd;
  const scale = baseEnd > 0 ? targetEnd / baseEnd : 1;
  const start = Date.parse(startedAt);
  return turns.map((turn, index) => ({
    ...turn,
    at: new Date(start + Math.round(baseOffsets[index]! * scale * 1000)).toISOString(),
  }));
}

function exactTimelineTurns(turns: ConversationTurn[], startedAt: string, offsets: (number | null)[], textOverrides?: (string | null)[] | null): ConversationTurn[] {
  if (!turns.length) return turns;
  const start = Date.parse(startedAt);
  let cursor = 0;
  return turns.map((turn, index) => {
    const raw = offsets[index];
    let offset = raw == null ? cursor : raw;
    if (index > 0 && offset < cursor) offset = cursor;
    cursor = offset + 0.2;
    return {
      ...turn,
      ...(textOverrides?.[index] ? { text: textOverrides[index]! } : {}),
      at: new Date(start + Math.round(offset * 1000)).toISOString(),
    };
  });
}
