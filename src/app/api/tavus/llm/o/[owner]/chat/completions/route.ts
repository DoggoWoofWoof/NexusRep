/**
 * Per-user Tavus custom-LLM endpoint. Each account's persona points its custom-LLM base_url at
 * /api/tavus/llm/o/<owner>, so the (cookie-less) Tavus request carries the container OWNER in the
 * URL. We inject it as the x-nexusrep-user-id header and delegate to the shared compliance handler,
 * which then loads THAT owner's container + active call — so two accounts on video at once never
 * cross-write into each other's sessions. All the gating/streaming lives in the base handler; this
 * only resolves whose call it is.
 */

import { POST as baseCompletions } from "@/app/api/tavus/llm/chat/completions/route";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ owner: string }> }): Promise<Response> {
  const { owner } = await ctx.params;
  const headers = new Headers(req.headers);
  headers.set("x-nexusrep-user-id", decodeURIComponent(owner || "").trim());
  const forwarded = new Request(req.url, { method: "POST", headers, body: await req.arrayBuffer() });
  return baseCompletions(forwarded);
}
