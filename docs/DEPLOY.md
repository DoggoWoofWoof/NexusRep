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
   - `NEXUSREP_COMPOSE=llm` if you want the live rep to use the LLM composer
   - `TAVUS_API_KEY`, `TAVUS_REPLICA_ID` (+ `TAVUS_PERSONA_ID` optional) — the Tavus realtime provider auto-selects when the key is present (`NEXUSREP_REALTIME_PROVIDER=tavus` to force)
   - `TAVUS_LLM_KEY` (shared secret Tavus uses to call our `/api/tavus/llm`)
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
   `TAVUS_LLM_KEY` (+ set `NEXUSREP_REALTIME_PROVIDER=tavus`), and the DocNexus cohort creds if used.
3. After the first deploy, set `NEXUSREP_PUBLIC_URL=https://<service>.onrender.com` and redeploy —
   Tavus calls back through it for every gated reply, so this must be the real public URL.
4. **Storage caveat**: without a persistent disk the instance filesystem is wiped on every deploy
   and restart, so `.nexusrep-data` (coaching, uploads, sessions) resets — same effect as the
   in-memory driver plus a re-seed. For durable state attach a paid persistent disk (uncomment the
   `disk:` block in `render.yaml`) and set `PGLITE_DATA_DIR=/var/data/nexusrep`.
5. Free-tier instances sleep after idle; the first request after sleep takes ~30–60s (cold boot +
   PGlite init + model warmup). The embedded MiniLM embedding model downloads on first use — the
   `starter` plan's memory is enough, but expect the first retrieval to be slower.
6. Open `https://<service>.onrender.com/hcp` for the doctor view; the brand console is at `/`.

## Notes
- **Secrets**: set every key in your shell / Vercel / the tunnel host. Do not commit `.env.local`.
- **Tavus billing**: each conversation uses minutes — don't loop the recorder.
- **Data durability**: in-memory re-seeds the demo rep on every boot (rep, guardrails, deck). For
  durable coaching/greeting edits across restarts, run locally with `NEXUSREP_DATA_DRIVER=postgres`
  (PGlite) — but a hosted serverless deploy needs a managed Postgres instead.
