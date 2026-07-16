# NexusRep scripts & setup

All helper scripts live here. Run them from the repo root with the dev server up
(`npm run dev`, port 3000). Node 20+ (they use built-in `fetch`).

## One-time / environment
- **App env** — copy `.env.example` → `.env.local`. Everything is optional; the app
  runs fully mocked with none of it. Keys that matter for the "everything real" demo:
  - `TAVUS_API_KEY` — the video rep. Basic plan = 25 min/mo. **Rotate** when a key runs
    dry (each key is a separate account). `TAVUS_REPLICA_ID` = the stock replica.
  - `NEXUSREP_DATA_DRIVER=postgres` — durable sessions/recordings (PGlite, dir
    `.nexusrep-data`; delete it to reset. If PGlite ever logs `RuntimeError: Aborted()`,
    delete `.nexusrep-data` and restart).
  - `NEXUSREP_PUBLIC_URL` — a public tunnel (cloudflared) so Tavus can reach our
    compliance endpoint + webhook.
  - `NEXUSREP_AUDIENCE=docnexus` + `DOCNEXUS_ADVANCED_SEARCH_URL=https://advanced-search.docnexus.ai`
    + `DOCNEXUS_ID_TOKEN_FILE=.docnexus-id-token.json` — real HCP data from hosted
    Advanced Search using the captured platform access token.
  - `DOCNEXUS_PLATFORM_EMAIL` + `DOCNEXUS_PLATFORM_PASSWORD` — lets NexusRep refresh
    `.docnexus-id-token.json` automatically when the token is missing or expired.

## Run the demo
```bash
NEXUSREP_DATA_DRIVER=postgres npm run dev            # :3000  NexusRep
cloudflared tunnel --url http://localhost:3000       # public URL → NEXUSREP_PUBLIC_URL
```

For hosted Advanced Search, set these once in `.env.local`:

```bash
NEXUSREP_AUDIENCE=docnexus
DOCNEXUS_ADVANCED_SEARCH_URL=https://advanced-search.docnexus.ai
DOCNEXUS_ID_TOKEN_FILE=.docnexus-id-token.json
DOCNEXUS_AUTO_REFRESH_TOKEN=1
DOCNEXUS_PLATFORM_EMAIL=...
DOCNEXUS_PLATFORM_PASSWORD=...
```

`npm run dev` will read the cached token file first. If the file is missing or the JWT
is near expiry, the audience provider runs `scripts/docnexus-platform-token.mjs`
automatically and then calls hosted Advanced Search with the fresh
`Authorization: Bearer` access token.

## Scripts
| Script | What it does |
| --- | --- |
| `scripts/gen-milvexian-deck.mjs` | Generates the branded, non-promotional **Milvexian deck** → `public/decks/milvexian.pptx` (pptxgenjs). Re-run after editing `src/lib/milvexian-deck.ts`. |
| `scripts/test-tavus-recording.mjs` | **Tests whether TAVUS'S OWN recording works** (not the client MediaRecorder the other scripts use): runs a short real session, ends it, then polls Tavus's conversation API for a recording URL (key only) and our `/api/sessions/{id}` for the webhook attach (needs a reachable `NEXUSREP_PUBLIC_URL`). Prints a clear verdict — run this before deciding whether to keep the Tavus recording path or switch to client capture. Needs Tavus credits (~1 short call). |
| `scripts/tavus-bot-record.mjs` | Records a **clean replica-only clip** (headless join of `/hcp?bare=1`, MediaRecorder on the replica stream, boot trimmed) and attaches it to `session_demo`. Needs Tavus credits. |
| `scripts/record-session-replay.mjs` | Drives a **full multi-turn doctor session** (video rep on, waits for the greeting, asks a scripted sequence), records the replica clip, and attaches it + the timestamped transcript to a fresh session → replays in the preview layout under Sessions. Needs Tavus credits. |
| `scripts/docnexus-platform-token.mjs` | Logs into `platform.docnexus.ai/insights`, captures the current platform Cognito tokens from browser auth state, writes `.docnexus-id-token.json`, and can smoke hosted Advanced Search with `--test-query`. |

## Verify (no browser)
```bash
npm test                                             # unit/integration tests
RUN_LIVE_DOCNEXUS=1 npx vitest run tests/docnexus.live.test.ts   # real HCP data (uses hosted Advanced Search + token refresh)
```

> Tavus recorders cost credits + take ~1–2 min each (replica boot + turns). Don't run
> them in a loop. For UI-only changes, use `npm test` + the browser, not the recorders.
