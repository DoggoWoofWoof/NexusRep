/**
 * DocNexus advanced-search adapter. Calls the hosted claims backend's
 * POST /api/query (outputCategory "type_1_npi") to fetch real cardiology
 * providers for the Milvexian target indications, and maps the response to
 * NexusRep's aggregate HCPFeatures. Only HCP-level aggregates cross this
 * boundary — never raw patient-level rows (hard rule).
 *
 * Auth: X-Api-Key (Kong), Authorization: Bearer with the captured DocNexus
 * platform access token, or legacy x-id-token for ID-token paths. If auth is
 * missing or the call fails/times out, the caller falls back to the modeled
 * cohort so the demo never depends on live infra being reachable.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { asId } from "@lib/ids";
import type { HcpId } from "@lib/ids";
import type { HCPFeatures } from "../index";
import type { AudienceProvider, AudienceQuery } from "./types";

const execFileAsync = promisify(execFile);
let tokenRefreshPromise: Promise<void> | null = null;

interface LoadedDocNexusToken {
  token: string;
  header: "x-id-token" | "authorization";
}

interface DocNexusRow {
  type_1_npi?: number | string;
  first_name?: string;
  last_name?: string;
  specialties?: string[] | string;
  group_1_patient_count?: number;
  primary_city?: string;
  primary_state?: string;
}

export interface DocNexusConfig {
  baseUrl: string;
  apiKey?: string;
  idToken?: string;
  idTokenFile?: string;
  autoRefreshToken?: boolean;
  tokenRefreshScript?: string;
  tokenRefreshTimeoutMs?: number;
  bearer?: string;
  timeoutMs?: number;
}

export class DocNexusAudienceProvider implements AudienceProvider {
  readonly name = "docnexus-advanced-search";
  constructor(private readonly config: DocNexusConfig) {}

  async fetchCohort(query: AudienceQuery): Promise<HCPFeatures[]> {
    // Payload per the SAGE /api/query reference: outputCategory type_1_npi honors
    // type1NpiConditions + medicalPharmacyConditions and supports orderByNumber.
    // We order by patient_number so the top rows are the highest-volume providers
    // (our density signal). NB: medical_table "…_blue" is the NBRx category's table,
    // not plain type_1_npi — production uses the default table here, so we omit it.
    const conditions = buildConditions(query);
    const body = {
      outputCategory: "type_1_npi",
      orderByNumber: "patient_number",
      // Specialty match is case-sensitive and the warehouse stores display names
      // in upper case (e.g. "CARDIOLOGY"), so normalize before sending.
      type1NpiConditions: { specialties: query.specialties.map((s) => s.toUpperCase()) },
      ...(conditions ? { medicalPharmacyConditions: conditions } : {}),
      limit: query.limit ?? 100,
      offset: 0,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5000);
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/api/query`, {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`advanced-search /api/query ${res.status}`);
      const json = (await res.json()) as { data?: DocNexusRow[] };
      const rows = Array.isArray(json.data) ? json.data : [];
      return mapRows(rows);
    } finally {
      clearTimeout(timer);
    }
  }

  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) h["X-Api-Key"] = this.config.apiKey;
    else if (this.config.idToken || this.config.idTokenFile) {
      const loaded = await loadIdToken(this.config);
      if (loaded?.header === "authorization") h.Authorization = `Bearer ${loaded.token}`;
      else if (loaded) h["x-id-token"] = loaded.token;
    }
    else if (this.config.bearer) h["Authorization"] = `Bearer ${this.config.bearer}`;
    return h;
  }
}

async function loadIdToken(
  config: Pick<DocNexusConfig, "idToken" | "idTokenFile" | "autoRefreshToken" | "tokenRefreshScript" | "tokenRefreshTimeoutMs">,
): Promise<LoadedDocNexusToken | undefined> {
  const inline = config.idToken?.trim();
  if (inline) return { token: inline, header: tokenHeader(inline) };
  const file = config.idTokenFile?.trim();
  if (!file) return undefined;

  const cached = await readFreshToken(file);
  if (cached) return cached;

  if (config.autoRefreshToken) {
    await refreshTokenFile(file, config);
    return readFreshToken(file);
  }

  return undefined;
}

async function readFreshToken(file: string): Promise<LoadedDocNexusToken | undefined> {
  try {
    const raw = await readFile(resolve(process.cwd(), file), "utf8");
    const loaded = parseTokenFile(raw);
    if (!loaded) return undefined;
    const exp = jwtExpMs(loaded.token);
    return !exp || exp > Date.now() + 60_000 ? loaded : undefined;
  } catch {
    return undefined;
  }
}

async function refreshTokenFile(
  file: string,
  config: Pick<DocNexusConfig, "tokenRefreshScript" | "tokenRefreshTimeoutMs">,
): Promise<void> {
  if (!tokenRefreshPromise) {
    tokenRefreshPromise = runTokenRefresh(file, config).finally(() => {
      tokenRefreshPromise = null;
    });
  }
  await tokenRefreshPromise;
}

async function runTokenRefresh(
  file: string,
  config: Pick<DocNexusConfig, "tokenRefreshScript" | "tokenRefreshTimeoutMs">,
): Promise<void> {
  const script = resolve(process.cwd(), config.tokenRefreshScript ?? "scripts/docnexus-platform-token.mjs");
  try {
    await execFileAsync(process.execPath, [script, "--out", file], {
      cwd: process.cwd(),
      env: process.env,
      timeout: config.tokenRefreshTimeoutMs ?? 120_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`DocNexus token refresh failed: ${message}`);
  }
}

function parseTokenFile(raw: string): LoadedDocNexusToken | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{")) return { token: trimmed, header: tokenHeader(trimmed) };
  try {
    const parsed = JSON.parse(trimmed) as { token?: unknown; idToken?: unknown; accessToken?: unknown };
    const accessToken = typeof parsed.accessToken === "string" ? parsed.accessToken.trim() : "";
    if (accessToken) return { token: accessToken, header: "authorization" };
    const token = typeof parsed.token === "string" ? parsed.token : typeof parsed.idToken === "string" ? parsed.idToken : "";
    const trimmedToken = token.trim();
    return trimmedToken ? { token: trimmedToken, header: tokenHeader(trimmedToken) } : undefined;
  } catch {
    return undefined;
  }
}

function tokenHeader(token: string): LoadedDocNexusToken["header"] {
  return jwtTokenUse(token) === "access" ? "authorization" : "x-id-token";
}

function jwtTokenUse(token: string): string | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { token_use?: unknown };
    return typeof parsed.token_use === "string" ? parsed.token_use : undefined;
  } catch {
    return undefined;
  }
}

function jwtExpMs(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const json = Buffer.from(normalized, "base64").toString("utf8");
    const parsed = JSON.parse(json) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * medicalPharmacyConditions per the SAGE reference: one OR-group per code type
 * (any-of within a type), groups joined by an AND root (must match each type).
 * Diagnosis codes are matched exactly (case-sensitive IN), so category codes like
 * "I48" match claims coded exactly "I48"; add subcodes if you need finer recall.
 * Returns undefined when there are no codes (backend ignores absent fields).
 */
function buildConditions(query: AudienceQuery):
  | { operator: string; children: { operator: string; children: { type: string; value: string }[] }[] }
  | undefined {
  const children: { operator: string; children: { type: string; value: string }[] }[] = [];
  if (query.diagnosisCodes?.length) {
    children.push({ operator: "OR", children: query.diagnosisCodes.map((value) => ({ type: "diagnosis", value })) });
  }
  if (query.drugBrandName) {
    children.push({ operator: "OR", children: [{ type: "drug_brand_name", value: query.drugBrandName }] });
  }
  return children.length ? { operator: "AND", children } : undefined;
}

/** Map claims rows → aggregate HCPFeatures, assigning deciles by volume rank. */
function mapRows(rows: DocNexusRow[]): HCPFeatures[] {
  const mapped = rows
    .filter((r) => r.type_1_npi != null)
    .map((r) => {
      const specialty = Array.isArray(r.specialties) ? r.specialties[0] ?? "Cardiology" : r.specialties ?? "Cardiology";
      const name = `Dr. ${[r.first_name, r.last_name].filter(Boolean).join(" ") || String(r.type_1_npi)}`;
      return {
        id: asId<"hcp_id">(`hcp_${r.type_1_npi}`) as HcpId,
        name,
        specialty,
        decile: 5, // reassigned below by volume rank
        eligiblePatients: Math.max(0, Math.round(r.group_1_patient_count ?? 0)),
        // Milvexian is investigational → no brand share; no field coverage yet.
        brandSharePct: 0,
        trendPct: 0,
        seesReps: true,
        repTouchesQtr: 0,
      } satisfies HCPFeatures;
    });

  const byVolumeDesc = [...mapped].sort((a, b) => b.eligiblePatients - a.eligiblePatients);
  const n = byVolumeDesc.length || 1;
  byVolumeDesc.forEach((f, i) => {
    f.decile = Math.min(10, Math.floor((i / n) * 10) + 1);
  });
  return byVolumeDesc;
}
