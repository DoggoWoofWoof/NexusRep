import { POST as tavusLlmPost } from "../../../../chat/completions/route";

export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  const { sessionId } = await ctx.params;
  const headers = new Headers(req.headers);
  headers.set("x-nexusrep-session-id", sessionId);
  headers.set("x-nexusrep-user-id", "__default__");
  return tavusLlmPost(new Request(req, { headers }));
}
