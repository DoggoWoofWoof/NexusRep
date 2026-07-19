import { POST as tavusLlmPost } from "../../../../chat/completions/route";
import { DEFAULT_OWNER_KEY } from "@lib/active-call";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await ctx.params;
  const headers = new Headers(req.headers);
  headers.set("x-nexusrep-session-id", sessionId);
  headers.set("x-nexusrep-user-id", DEFAULT_OWNER_KEY);
  return tavusLlmPost(new Request(req, { headers }));
}
