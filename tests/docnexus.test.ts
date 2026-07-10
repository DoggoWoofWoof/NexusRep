/**
 * Locks the DocNexus /api/query payload to the SAGE Payload Reference:
 * outputCategory type_1_npi + type1NpiConditions.specialties + a
 * medicalPharmacyConditions AND-root / OR-group diagnosis tree, ordered by
 * patient_number, with NO NBRx-only "…_blue" table override.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocNexusAudienceProvider, MILVEXIAN_AUDIENCE_QUERY } from "@modules/audience";

afterEach(() => vi.unstubAllGlobals());

describe("DocNexus /api/query payload (SAGE reference)", () => {
  it("shapes the request exactly as the reference and maps the response", async () => {
    let captured: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      captured = { url: String(url), headers: (init?.headers as Record<string, string>) ?? {}, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ data: [{ type_1_npi: 123, first_name: "Jane", last_name: "Doe", specialties: ["Cardiology"], group_1_patient_count: 2500 }] }), { status: 200 });
    }) as typeof fetch);

    const provider = new DocNexusAudienceProvider({ baseUrl: "https://advanced-search.docnexus.ai", apiKey: "k" });
    const cohort = await provider.fetchCohort(MILVEXIAN_AUDIENCE_QUERY);

    const b = captured!.body as {
      outputCategory: string;
      orderByNumber: string;
      medical_table?: string;
      pharmacy_table?: string;
      type1NpiConditions: { specialties: string[] };
      medicalPharmacyConditions: { operator: string; children: { operator: string; children: { type: string; value: string }[] }[] };
      limit: number;
    };
    expect(captured!.url).toBe("https://advanced-search.docnexus.ai/api/query");
    expect(captured!.headers["X-Api-Key"]).toBe("k");
    expect(b.outputCategory).toBe("type_1_npi");
    expect(b.orderByNumber).toBe("patient_number");
    expect(b.medical_table).toBeUndefined(); // NBRx-only table must NOT be sent for type_1_npi
    expect(b.pharmacy_table).toBeUndefined();
    // Specialty match is case-sensitive; the warehouse stores upper-case display
    // names, so the provider normalizes before sending.
    expect(b.type1NpiConditions.specialties).toContain("CARDIOLOGY");
    expect(b.medicalPharmacyConditions.operator).toBe("AND");
    expect(b.medicalPharmacyConditions.children[0]!.operator).toBe("OR");
    expect(b.medicalPharmacyConditions.children[0]!.children[0]).toEqual({ type: "diagnosis", value: "I48" });
    expect(b.limit).toBe(50);

    // Response → aggregate HCPFeatures (patient count → density signal; no PHI).
    expect(cohort).toHaveLength(1);
    expect(cohort[0]).toMatchObject({ id: "hcp_123", name: "Dr. Jane Doe", specialty: "Cardiology", eligiblePatients: 2500, brandSharePct: 0 });
  });

  it("omits medicalPharmacyConditions entirely when no codes are given", async () => {
    let body: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch);
    await new DocNexusAudienceProvider({ baseUrl: "https://x", apiKey: "k" }).fetchCohort({ specialties: ["Cardiology"] });
    expect(body!.medicalPharmacyConditions).toBeUndefined();
    expect((body as unknown as { type1NpiConditions: { specialties: string[] } }).type1NpiConditions.specialties).toEqual(["CARDIOLOGY"]);
  });

  it("sends a platform Cognito ID token as x-id-token", async () => {
    let headers: Record<string, string> | null = null;
    vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
      headers = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch);

    await new DocNexusAudienceProvider({ baseUrl: "https://x", idToken: "id.jwt.token" }).fetchCohort({ specialties: ["Cardiology"] });

    expect(headers!["x-id-token"]).toBe("id.jwt.token");
    expect(headers!.Authorization).toBeUndefined();
  });

  it("uses the platform access token captured by scripts/docnexus-platform-token.mjs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexusrep-docnexus-"));
    try {
      const tokenFile = join(dir, "token.json");
      const futureExp = Math.floor(Date.now() / 1000) + 3600;
      const accessToken = makeUnsignedJwt({ exp: futureExp, email: "hcp@example.com", token_use: "access" });
      const idToken = makeUnsignedJwt({ exp: futureExp, email: "hcp@example.com", token_use: "id" });
      await writeFile(tokenFile, JSON.stringify({ token: accessToken, accessToken, idToken, headerName: "Authorization" }));

      let headers: Record<string, string> | null = null;
      vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
        headers = (init?.headers as Record<string, string>) ?? {};
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch);

      await new DocNexusAudienceProvider({ baseUrl: "https://x", idTokenFile: tokenFile }).fetchCohort({ specialties: ["Cardiology"] });
      expect(headers!.Authorization).toBe(`Bearer ${accessToken}`);
      expect(headers!["x-id-token"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refreshes the platform token automatically when the token file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexusrep-docnexus-refresh-"));
    try {
      const tokenFile = join(dir, "token.json");
      const refreshScript = join(dir, "refresh.mjs");
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const accessToken = makeUnsignedJwt({ exp, email: "hcp@example.com", token_use: "access" });
      const idToken = makeUnsignedJwt({ exp, email: "hcp@example.com", token_use: "id" });
      await writeFile(
        refreshScript,
        `
const out = process.argv[process.argv.indexOf("--out") + 1];
await import("node:fs/promises").then(({ writeFile }) => writeFile(out, JSON.stringify({
  token: ${JSON.stringify(accessToken)},
  accessToken: ${JSON.stringify(accessToken)},
  idToken: ${JSON.stringify(idToken)},
  headerName: "Authorization"
})));
`,
      );

      let headers: Record<string, string> | null = null;
      vi.stubGlobal("fetch", (async (_url: string, init?: RequestInit) => {
        headers = (init?.headers as Record<string, string>) ?? {};
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as typeof fetch);

      await new DocNexusAudienceProvider({
        baseUrl: "https://x",
        idTokenFile: tokenFile,
        autoRefreshToken: true,
        tokenRefreshScript: refreshScript,
        tokenRefreshTimeoutMs: 5000,
      }).fetchCohort({ specialties: ["Cardiology"] });

      expect(headers!.Authorization).toBe(`Bearer ${accessToken}`);
      expect(headers!["x-id-token"]).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function makeUnsignedJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

// ── Browserless Cognito refresh (how the live cohort authenticates on a server) ──
import { refreshCognitoTokens } from "@modules/audience/providers/docnexus";

describe("refreshCognitoTokens", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mints a fresh access token via REFRESH_TOKEN_AUTH (no browser)", async () => {
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("https://cognito-idp.us-east-9.amazonaws.com/");
      const body = JSON.parse(String(init?.body)) as { AuthFlow: string; ClientId: string; AuthParameters: { REFRESH_TOKEN: string } };
      expect(body.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
      expect(body.ClientId).toBe("client123");
      expect(body.AuthParameters.REFRESH_TOKEN).toBe("rt-abc");
      return new Response(JSON.stringify({ AuthenticationResult: { AccessToken: "fresh-at", IdToken: "fresh-id" } }), { status: 200 });
    }) as typeof fetch);
    const r = await refreshCognitoTokens({ refreshToken: "rt-abc", clientId: "client123", region: "us-east-9" });
    expect(r).toEqual({ accessToken: "fresh-at", idToken: "fresh-id" });
  });

  it("fails safe (null) on HTTP errors and network failures — caller falls back", async () => {
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 400 })) as typeof fetch);
    expect(await refreshCognitoTokens({ refreshToken: "x", clientId: "y", region: "us-east-1" })).toBeNull();
    vi.stubGlobal("fetch", (async () => { throw new Error("offline"); }) as typeof fetch);
    expect(await refreshCognitoTokens({ refreshToken: "x", clientId: "y", region: "us-east-1" })).toBeNull();
  });
});

// ── Render path: the refresh trio ALONE must authenticate the live query ──
describe("DocNexus provider with only the Cognito refresh trio (server deployment)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mints an access token and sends it as the Bearer (no token file, no inline token)", async () => {
    const seen: { cognito: number; queryAuth: string | null } = { cognito: 0, queryAuth: null };
    // A real-shaped JWT (alg none padding irrelevant — only exp is decoded) valid for an hour.
    const fakeJwt = (use: string) => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      return `${b64({ alg: "none" })}.${b64({ token_use: use, exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
    };
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("cognito-idp.")) {
        seen.cognito++;
        return new Response(JSON.stringify({ AuthenticationResult: { AccessToken: fakeJwt("access"), IdToken: fakeJwt("id") } }), { status: 200 });
      }
      if (u.endsWith("/api/query")) {
        seen.queryAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch);

    const provider = new DocNexusAudienceProvider({
      baseUrl: "https://advanced-search.example",
      refreshToken: "refresh-token-value",
      cognitoClientId: "client123",
      cognitoRegion: "ap-southeast-2",
    });
    await provider.fetchCohort({ specialties: ["Cardiology"], diagnosisCodes: [], limit: 5 });
    expect(seen.cognito).toBeGreaterThanOrEqual(1); // the trio actually minted
    expect(seen.queryAuth).toMatch(/^Bearer .+/); // and the query carried it
  });
});
