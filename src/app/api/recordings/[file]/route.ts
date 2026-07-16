/**
 * Serves a captured session recording. We stream it from disk here rather than relying on Next's
 * static /public serving, because a file written AT RUNTIME (the client-captured clip) isn't reliably
 * served by `next start` in production / on Render — that's why the Session-review video pane loaded
 * nothing. This route always runs, so the recording plays as soon as it's uploaded. Supports Range so
 * the <video> element can seek.
 */

import { NextResponse } from "next/server";
import { stat, readFile, open } from "node:fs/promises";
import { localRecordingPath } from "@lib/recording-store";

export const dynamic = "force-dynamic";

function contentType(file: string): string {
  return /\.mp4$/i.test(file) ? "video/mp4" : "video/webm";
}

export async function GET(req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  const path = localRecordingPath(file);
  if (!path) return NextResponse.json({ error: "bad recording name" }, { status: 400 });

  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return NextResponse.json({ error: "recording not found" }, { status: 404 });
  }
  const type = contentType(file);
  const range = req.headers.get("range");

  // Range request → 206 partial so the <video> can seek without downloading the whole clip.
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (Number.isNaN(start) || start > end || start >= size) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(end - start + 1);
      await fh.read(buf, 0, buf.length, start);
      return new NextResponse(buf, {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Length": String(buf.length),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=3600",
        },
      });
    } finally {
      await fh.close();
    }
  }

  const bytes = await readFile(path);
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
