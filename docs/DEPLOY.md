# Deploying NexusRep for testing

The one thing that unlocks real end-to-end testing (especially the **live Tavus video rep**) is a
**public URL** for this app. Tavus's servers call our compliance endpoint (`/api/tavus/llm`) to get
every reply — if the app is only on `localhost`, the replica renders and greets but stays silent on
HCP turns. So step 1 is always: give the app a public URL and point `NEXUSREP_PUBLIC_URL` at it.

## Option A — Public tunnel over the local dev server (fastest, for testing)

Keeps your local `npm run dev` and exposes it publicly. Best for iterating + testing Tavus without a
real deploy.

1. Start the app locally (in-memory is fine and robust for testing):
   ```bash
   NEXUSREP_DATA_DRIVER=memory npm run dev
   ```
2. In a second terminal, open a tunnel to port 3000 (pick one you have):
   ```bash
   # Cloudflare (no account needed):
   npx cloudflared tunnel --url http://localhost:3000
   #   → prints https://<random>.trycloudflare.com
   # or ngrok (needs a free account/token):
   npx ngrok http 3000
   ```
3. Put that HTTPS URL in `.env.local` and restart dev so the Tavus persona's custom-LLM base_url
   uses it:
   ```
   NEXUSREP_PUBLIC_URL=https://<random>.trycloudflare.com
   ```
4. Open `https://<random>.trycloudflare.com/hcp`, start the video rep, and talk. Now:
   - Tavus reaches `/api/tavus/llm` → replies are gated by our orchestrator.
   - Rep turns are logged **server-side with their slide** → the Session review slide follows.
   - The recording trims to the replica's first words.

## Option B — Hosted deploy (Vercel)

For a shareable, always-on URL. Caveat: **PGlite (the durable local DB) does not work on Vercel's
ephemeral/serverless filesystem** — use in-memory for a demo, or point at a managed Postgres.

1. `npm i -g vercel` (or use the dashboard) → `vercel` → link the project.
2. Set env vars in the Vercel project (Settings → Environment Variables). **Set the values in Vercel,
   never commit them.** Required/likely:
   - `NEXUSREP_PUBLIC_URL` = your Vercel URL (e.g. `https://nexusrep.vercel.app`)
   - `ANTHROPIC_API_KEY` (for LLM compose/coaching) and/or `OPENAI_API_KEY`
   - `ANTHROPIC_MODEL=claude-haiku-4-5` for realtime video latency unless you explicitly
     want a slower/larger model.
   - `NEXUSREP_COMPOSE=llm` if you want the live rep to use the LLM composer
   - Leave `NEXUSREP_TAVUS_COMPOSE` unset so Tavus video uses the same grounded composer as
     the live rep; set it to `deterministic` only as an explicit emergency/cost/latency fallback.
   - `TAVUS_API_KEY`, `TAVUS_REPLICA_ID` (+ `TAVUS_PERSONA_ID` optional) — the Tavus realtime provider auto-selects when the key is present (`NEXUSREP_REALTIME_PROVIDER=tavus` to force)
   - `TAVUS_LLM_KEY` (shared secret Tavus uses to call our `/api/tavus/llm`)
   - Optional Tavus speech tuning: `NEXUSREP_TAVUS_TTS_ENGINE=cartesia`,
     `NEXUSREP_TAVUS_TTS_MODEL=sonic-3`, `NEXUSREP_TAVUS_TTS_SPEED=1.08`.
   - `NEXUSREP_DATA_DRIVER=memory` (serverless) — data resets on redeploy; fine for a demo.
   - `NEXUSREP_AUDIENCE=modeled` unless you wire the DocNexus cohort backend.
3. `vercel --prod`. Open `/hcp`.

## Option C — Render (blueprint included: `render.yaml`)

A long-running Node server — unlike serverless, **PGlite works here** (the process keeps its
filesystem between requests), so the durable store runs as-is. The repo ships a blueprint.

1. Push the repo to GitHub, then in Render: **New → Blueprint** → pick the repo. Render reads
   `render.yaml` and creates the `nexusrep` web service (`npm ci && npm run build` / `npm run start`).
2. Fill the secret env vars in the Render dashboard (they are `sync: false` in the blueprint —
   values are never committed): `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`, `TAVUS_API_KEY` +
   `TAVUS_LLM_KEY` (a shared secret YOU invent — Tavus sends it back as the Bearer when calling
   our compliance endpoint; set `NEXUSREP_REALTIME_PROVIDER=tavus` for the video rep).
   Use `ANTHROPIC_MODEL=claude-haiku-4-5` for the realtime demo path unless you intentionally
   choose a slower model.
   Leave `NEXUSREP_TAVUS_COMPOSE` unset for normal demos so Tavus inherits `NEXUSREP_COMPOSE`
   and uses grounded LLM composition when your model key is present.
   The default Tavus PAL TTS layer is Cartesia `sonic-3` at speed `1.08`; override the
   `NEXUSREP_TAVUS_TTS_*` envs only if the actual rendered voice feels too fast/slow.
   **Live DocNexus cohort on a server (no static API key exists — auth is account-based):** run
   `node scripts/docnexus-platform-token.mjs` locally once; it captures a ~30-day Cognito
   REFRESH token into `.docnexus-id-token.json`. Copy `refreshToken` / `clientId` / `region`
   from that file into `DOCNEXUS_REFRESH_TOKEN` / `DOCNEXUS_COGNITO_CLIENT_ID` /
   `DOCNEXUS_COGNITO_REGION` — the server then mints fresh access tokens itself via plain
   HTTPS (no browser needed). Re-run the script + update the env when the refresh token
   eventually expires.
3. After the first deploy, set `NEXUSREP_PUBLIC_URL=https://<service>.onrender.com` and redeploy —
   Tavus calls back through it for every gated reply, so this must be the real public URL.
4. **Storage**: the blueprint attaches a 1 GB persistent disk (`/var/data`) and points
   `PGLITE_DATA_DIR` at it, so coaching, script edits, MLR decisions, uploads and sessions
   survive deploys and restarts (~$0.25/GB/mo on top of the instance). Remove the `disk:` block
   only if you want an ephemeral reset-on-deploy demo. The retrieval index rebuilds itself from
   the durable store on every boot.
5. **Memory**: Starter (512MB) cannot hold the neural embeddings model — the blueprint sets
   `NEXUSREP_EMBEDDINGS=lexical` (same validation + gate, lexical ranking). For neural
   retrieval in production, use a >=2GB instance and set it to `auto`.
6. Open `https://<service>.onrender.com/hcp` for the doctor view; the brand console is at `/`.

## Notes
- **Secrets**: set every key in your shell / Vercel / the tunnel host. Do not commit `.env.local`.
- **Tavus billing**: each conversation uses minutes — don't loop the recorder.
- **Data durability**: in-memory re-seeds the demo rep on every boot (rep, guardrails, deck). For
  durable coaching/greeting edits across restarts, run locally with `NEXUSREP_DATA_DRIVER=postgres`
  (PGlite) — but a hosted serverless deploy needs a managed Postgres instead.
