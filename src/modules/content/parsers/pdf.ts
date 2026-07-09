/**
 * Real PDF text extractor. A PDF's text lives in content streams that need a full
 * PDF parser to decode; we use `pdf-parse` (a thin wrapper over Mozilla's pdf.js)
 * to pull the text for each page in page order and return one plain-text string
 * per page — the same "one block per unit" contract the .pptx parser produces
 * (one block per slide), so the ingest normalizer downstream is unchanged.
 *
 * pdf.js is heavy (it pulls a large legacy build), so it is loaded LAZILY inside
 * `parsePdf` — importing this module never drags pdf.js into a bundle unless a PDF
 * is actually ingested. Text-only: we never call the image/canvas paths.
 */

/** Extract text from a PDF buffer, one string per page, joined by blank lines. */
export async function parsePdf(data: Uint8Array): Promise<string> {
  // Lazy import: keep pdf.js out of the module graph until a PDF is really parsed.
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    // One block per page (blank-line separated) mirrors the .pptx "one block per
    // slide" shape, so `parseBlocks` keeps page boundaries → one approved-answer +
    // one detail-aid slide per page. Fall back to the whole-doc text if page-wise
    // extraction yielded nothing.
    const pages = result.pages?.length ? result.pages.map((p) => p.text) : [result.text];
    return pages
      .map((t) =>
        (t ?? "")
          .replace(/-{2,}\s*\d+\s+of\s+\d+\s*-{2,}/g, "") // pdf-parse "-- N of M --" page markers (whole-doc fallback)
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      )
      .filter((t) => t.length > 0)
      .join("\n\n");
  } finally {
    await parser.destroy().catch(() => {
      /* best-effort cleanup */
    });
  }
}

/** True if the filename looks like a PDF we can parse. */
export function isPdf(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pdf");
}
