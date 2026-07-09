#!/usr/bin/env node

/**
 * Refresh DocNexus platform Cognito tokens by logging into
 * https://platform.docnexus.ai/insights and reading the platform auth state from
 * request headers or browser storage. Hosted Advanced Search currently accepts
 * the platform access token as Authorization: Bearer; the ID token is retained in
 * the cache for traceability/fallback. Tokens are written to a local ignored file
 * for NexusRep's DocNexusAudienceProvider to read.
 *
 * Required env:
 *   DOCNEXUS_PLATFORM_EMAIL
 *   DOCNEXUS_PLATFORM_PASSWORD
 *
 * Common usage:
 *   node scripts/docnexus-platform-token.mjs --test-query
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

loadEnvFile(".env.local");
loadEnvFile(".env");

const args = new Set(process.argv.slice(2));
const debug = args.has("--debug");
const platformUrl = argValue("--platform-url") ?? process.env.DOCNEXUS_PLATFORM_URL ?? "https://platform.docnexus.ai/insights";
const advancedSearchUrl =
  argValue("--advanced-search-url") ?? process.env.DOCNEXUS_ADVANCED_SEARCH_URL ?? "https://advanced-search.docnexus.ai";
const outPath = resolve(
  process.cwd(),
  argValue("--out") ?? process.env.DOCNEXUS_TOKEN_OUT ?? process.env.DOCNEXUS_ID_TOKEN_FILE ?? ".docnexus-id-token.json",
);
const headless = !args.has("--headful") && process.env.DOCNEXUS_TOKEN_HEADFUL !== "1";
const email = process.env.DOCNEXUS_PLATFORM_EMAIL?.trim();
const password = process.env.DOCNEXUS_PLATFORM_PASSWORD ?? "";

if (args.has("--help") || args.has("-h")) {
  printHelp();
  process.exit(0);
}

if (!email || !password) {
  fail(
    "Missing DOCNEXUS_PLATFORM_EMAIL or DOCNEXUS_PLATFORM_PASSWORD. Set them in your shell or .env.local; do not hardcode them.",
  );
}

const browser = await chromium.launch({ headless });
const context = await browser.newContext();
const page = await context.newPage();

let captured;
const recentRequests = [];
const captureToken = (token, from, headerName = "x-id-token") => {
  if (!token || captured) return;
  captured = {
    token,
    headerName,
    capturedAt: new Date().toISOString(),
    capturedFrom: from,
    source: platformUrl,
    ...decodeJwt(token),
  };
};

const maybeCaptureRequest = (request) => {
  const url = request.url();
  rememberRequest(url);
  const headers = request.headers();
  if (headers["x-id-token"]) captureToken(headers["x-id-token"], url);
};

const maybeCaptureResponse = async (response) => {
  try {
    const headers = await response.allHeaders().catch(() => response.headers());
    if (headers["x-id-token"]) captureToken(headers["x-id-token"], response.url());
  } catch {
    // Some browser/protocol responses cannot expose headers; ignore and keep watching.
  }
};

page.on("request", maybeCaptureRequest);
page.on("response", (response) => void maybeCaptureResponse(response));

try {
  await page.goto(platformUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await signInIfNeeded(page, email, password);
  captured = (await captureFromBrowserStorage(page, platformUrl)) ?? captured;
  if (!captured) {
    await page.goto(platformUrl, { waitUntil: "networkidle", timeout: 60_000 }).catch(async () => {
      await page.goto(platformUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    });
  }

  const deadline = Date.now() + 45_000;
  while (!captured && Date.now() < deadline) {
    await page.waitForTimeout(500);
    captured = await captureFromBrowserStorage(page, platformUrl);
    if (!/insights/i.test(page.url())) {
      await page.goto(platformUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
    }
  }

  if (!captured) {
    if (debug) await printDebugState(page, recentRequests);
    throw new Error("Logged in but did not observe a platform Cognito token in request headers, response headers, or browser storage.");
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(captured, null, 2)}\n`, { mode: 0o600 });

  console.log(`Captured DocNexus platform token -> ${relativePath(outPath)}`);
  if (captured.email) console.log(`Token subject: ${captured.email}`);
  if (captured.expiresAt) console.log(`Expires: ${captured.expiresAt}`);
  console.log(`Use with NexusRep: DOCNEXUS_ID_TOKEN_FILE=${relativePath(outPath)}`);

  if (args.has("--test-query")) {
    await testAdvancedSearch(advancedSearchUrl, captured.token);
  }
} finally {
  await browser.close();
}

async function signInIfNeeded(page, username, secret) {
  if (await captureFromBrowserStorage(page, page.url())) return;

  let emailInput = await firstVisible(page, [
    "input[type='email']",
    "input[name='email']",
    "input[name='username']",
    "input#email",
    "input#username",
    "input[autocomplete='username']",
    "input[autocomplete='email']",
    "input[placeholder*='email' i]",
    "input[placeholder*='username' i]",
  ], 1500);
  if (!emailInput) {
    await page.goto(new URL(platformUrl).origin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    emailInput = await firstVisible(page, [
      "input[type='email']",
      "input[name='email']",
      "input[name='username']",
      "input#email",
      "input#username",
      "input[autocomplete='username']",
      "input[autocomplete='email']",
      "input[placeholder*='email' i]",
      "input[placeholder*='username' i]",
    ]);
  }
  if (!emailInput) return;

  await emailInput.fill(username);
  let passwordInput = await firstVisible(page, [
    "input[type='password']",
    "input[name='password']",
    "input#password",
    "input[autocomplete='current-password']",
  ], 1500);
  if (!passwordInput) {
    await clickFirst(page, [
      "button:has-text('Continue')",
      "button:has-text('Next')",
      "button:has-text('Sign in')",
      "button:has-text('Log in')",
      "button[type='submit']",
    ]);
    passwordInput = await firstVisible(page, [
      "input[type='password']",
      "input[name='password']",
      "input#password",
      "input[autocomplete='current-password']",
    ]);
  }
  if (!passwordInput) {
    throw new Error("Found login email field, but no password field appeared.");
  }
  await passwordInput.fill(secret);
  await clickFirst(page, [
    "button:has-text('Sign in')",
    "button:has-text('Log in')",
    "button:has-text('Continue')",
    "button[type='submit']",
  ]);

  await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => undefined);
  await waitForStoredIdToken(page, 30_000);
}

function rememberRequest(url) {
  if (/user|tag|auth|token|cognito|api|insights/i.test(url)) {
    recentRequests.push(url);
    while (recentRequests.length > 40) recentRequests.shift();
  }
}

async function printDebugState(page, requests) {
  const state = await page
    .evaluate(() => {
      const storageKeys = [];
      for (const storeName of ["localStorage", "sessionStorage"]) {
        const store = window[storeName];
        for (let i = 0; i < store.length; i += 1) {
          storageKeys.push(`${storeName}:${store.key(i) ?? ""}`);
        }
      }
      return {
        href: window.location.href,
        storageKeys,
        bodyText: document.body?.innerText?.slice(0, 1000) ?? "",
        inputs: [...document.querySelectorAll("input")].slice(0, 20).map((input) => ({
          type: input.getAttribute("type"),
          name: input.getAttribute("name"),
          id: input.getAttribute("id"),
          autocomplete: input.getAttribute("autocomplete"),
          placeholder: input.getAttribute("placeholder"),
        })),
        buttons: [...document.querySelectorAll("button")].slice(0, 20).map((button) => button.innerText?.slice(0, 80)),
      };
    })
    .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  console.error("Debug page state:", JSON.stringify(state, null, 2));
  console.error("Recent relevant requests:", JSON.stringify(requests, null, 2));
}

async function _hasLoginField(page) {
  return Boolean(await firstVisible(page, ["input[type='email']", "input[name='email']", "input[name='username']"], 1000));
}

async function firstVisible(page, selectors, timeout = 10_000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout });
      return locator;
    } catch {
      // Try the next common auth-page selector.
    }
  }
  return null;
}

async function clickFirst(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.click({ timeout: 3000 });
      return true;
    } catch {
      // Try the next common button selector.
    }
  }
  await page.keyboard.press("Enter");
  return false;
}

async function captureFromBrowserStorage(page, source) {
  const storage = await page
    .evaluate(() => {
      const entries = [];
      for (const storeName of ["localStorage", "sessionStorage"]) {
        const store = window[storeName];
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i) ?? "";
          entries.push({ storeName, key, value: store.getItem(key) ?? "" });
        }
      }
      return entries;
    })
    .catch(() => []);

  const platformTokens = {};
  let sourceEntry;
  for (const entry of storage) {
    const tokens = pickPlatformTokens(entry.key, entry.value);
    if (tokens.accessToken || tokens.idToken) {
      sourceEntry ??= entry;
      Object.assign(platformTokens, tokens);
    }
  }
  if (platformTokens.accessToken || platformTokens.idToken) {
    const token = platformTokens.accessToken ?? platformTokens.idToken;
    return {
      token,
      accessToken: platformTokens.accessToken,
      idToken: platformTokens.idToken,
      authHeaderName: platformTokens.accessToken ? "Authorization" : "x-id-token",
      headerName: platformTokens.accessToken ? "Authorization" : "x-id-token",
      capturedAt: new Date().toISOString(),
      capturedFrom: `${source} ${sourceEntry.storeName}:${sourceEntry.key}`,
      source,
      ...decodeJwt(token),
    };
  }
  return undefined;
}

async function waitForStoredIdToken(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await captureFromBrowserStorage(page, page.url());
    if (found) return found;
    await page.waitForTimeout(500);
  }
  return undefined;
}

function pickPlatformTokens(key, value) {
  const candidates = new Set();
  if (typeof value === "string") {
    for (const match of value.matchAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g)) {
      candidates.add(match[0]);
    }
  }

  const tokens = {};
  for (const token of candidates) {
    const claims = decodeJwt(token);
    if (claims.tokenUse === "access" || /accesstoken|access_token/i.test(key)) tokens.accessToken = token;
    if (claims.tokenUse === "id" || /idtoken|id_token/i.test(key)) tokens.idToken = token;
  }
  return tokens;
}

async function testAdvancedSearch(baseUrl, token) {
  const payload = {
    outputCategory: "type_1_npi",
    orderByNumber: "patient_number",
    type1NpiConditions: { specialties: ["CARDIOLOGY"] },
    limit: 1,
    offset: 0,
  };

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Advanced Search test query failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const json = JSON.parse(text);
  const count = Array.isArray(json.data) ? json.data.length : 0;
  console.log(`Advanced Search test query OK: ${count} row(s).`);
}

function argValue(name) {
  const argv = process.argv.slice(2);
  const equals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function decodeJwt(token) {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    const expiresAt = typeof claims.exp === "number" ? new Date(claims.exp * 1000).toISOString() : undefined;
    return {
      expiresAt,
      email: typeof claims.email === "string" ? claims.email : undefined,
      tokenUse: typeof claims.token_use === "string" ? claims.token_use : undefined,
    };
  } catch {
    return {};
  }
}

function loadEnvFile(file) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match || process.env[match[1]] != null) continue;
    process.env[match[1]] = unquote(match[2]);
  }
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function relativePath(path) {
  return path.startsWith(process.cwd()) ? path.slice(process.cwd().length + 1).replace(/\\/g, "/") : path;
}

function printHelp() {
  console.log(`Usage: node scripts/docnexus-platform-token.mjs [--test-query] [--headful] [--debug] [--out .docnexus-id-token.json]

Env:
  DOCNEXUS_PLATFORM_EMAIL       DocNexus platform login email
  DOCNEXUS_PLATFORM_PASSWORD    DocNexus platform login password
  DOCNEXUS_PLATFORM_URL         Default: https://platform.docnexus.ai/insights
  DOCNEXUS_ADVANCED_SEARCH_URL  Default: https://advanced-search.docnexus.ai
  DOCNEXUS_ID_TOKEN_FILE        Default token output for NexusRep
  DOCNEXUS_TOKEN_OUT            Overrides DOCNEXUS_ID_TOKEN_FILE

The token value is written to the output file and is not printed by default.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
