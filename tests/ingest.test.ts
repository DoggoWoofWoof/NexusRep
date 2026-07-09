import { describe, expect, it } from "vitest";
import { asId, type MlrApprovalId } from "@lib/ids";
import { extractSourceText, ingestSource, isPdf, parseBlocks, type RawSource } from "@modules/content";

/** Build a real, minimal multi-page text PDF (Helvetica) with a correct xref, so the PDF
 *  parser is exercised against a genuine byte stream — not a stub. One line per page. */
function buildPdf(pages: string[]): Uint8Array {
  let pdf = "%PDF-1.4\n";
  const off: Record<number, number> = {};
  const add = (n: number, body: string) => {
    off[n] = Buffer.byteLength(pdf, "latin1");
    pdf += `${n} 0 obj\n${body}\nendobj\n`;
  };
  const n = pages.length;
  const pageObjs = pages.map((_, i) => 3 + i);
  const contentObjs = pages.map((_, i) => 3 + n + i);
  const fontObj = 3 + n * 2;
  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(2, `<< /Type /Pages /Kids [${pageObjs.map((x) => `${x} 0 R`).join(" ")}] /Count ${n} >>`);
  pages.forEach((_, i) =>
    add(pageObjs[i]!, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjs[i]} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`),
  );
  pages.forEach((text, i) => {
    const stream = `BT /F1 18 Tf 72 700 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
    add(contentObjs[i]!, `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  });
  add(fontObj, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xrefStart = Buffer.byteLength(pdf, "latin1");
  let xref = `xref\n0 ${fontObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= fontObj; i++) xref += `${String(off[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `${xref}trailer\n<< /Size ${fontObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

const mlr = {
  mlrApprovalId: asId<"mlr_approval_id">("mlr_x") as MlrApprovalId,
  status: "active" as const,
  version: 1,
  audience: "cardiologist",
  indication: "ACS",
  market: "US",
  expiresAt: "2027-01-01",
  sourceFile: "detail.pptx",
};

describe("content ingestion / normalization", () => {
  it("splits raw text into approved blocks", () => {
    expect(parseBlocks("Block one.\n\nBlock two.\n\n\nBlock three.")).toEqual(["Block one.", "Block two.", "Block three."]);
  });

  it("normalizes a detail aid into canonical answers + slides with inferred topics", () => {
    const raw: RawSource = {
      kind: "ppt",
      title: "ACS Detail",
      text: "The maintenance dose is once daily after titration.\n\nIn the pivotal trial the endpoint was met versus placebo.",
      mlr,
    };
    const res = ingestSource(raw, "t1");
    expect(res.answers).toHaveLength(2);
    expect(res.slides).toHaveLength(2);
    expect(res.answers[0]!.topic).toBe("dosing");
    expect(res.answers[1]!.topic).toBe("trial_data");
    expect(res.slides[0]!.title).toBe("The maintenance dose is once daily after titration");
    expect(res.slides[0]!.label).toContain("Dosing");
    // Every answer is backed by MLR metadata and a detail-aid slide.
    expect(res.answers[0]!.mlr.status).toBe("active");
    expect(res.answers[0]!.detailAidSlideId).toBe(res.slides[0]!.id);
  });

  it("recognizes public product-detail topics from deck/PDF text", () => {
    const raw: RawSource = {
      kind: "ppt",
      title: "Milvexian Detail Aid",
      text: [
        "Milvexian mechanism of action: Factor XIa inhibition.",
        "The LIBREXIA Phase 3 program includes ACS, AF, and ischemic stroke.",
        "Development status: investigational and not FDA approved.",
      ].join("\n\n"),
      mlr,
    };
    const res = ingestSource(raw, "topics");
    expect(res.answers.map((a) => a.topic)).toEqual(["mechanism", "program", "status"]);
    expect(res.slides.map((s) => s.title)).toEqual([
      "Milvexian mechanism of action: Factor XIa inhibition",
      "The LIBREXIA Phase 3 program includes ACS, AF, and ischemic stroke",
      "Development status: investigational and not FDA approved",
    ]);
  });

  it("normalizes an ISI source into verbatim safety statements, not answers", () => {
    const raw: RawSource = { kind: "isi", title: "ISI", text: "Do not use with active bleeding.\n\nAssess renal function first.", mlr };
    const res = ingestSource(raw, "t2");
    expect(res.answers).toHaveLength(0);
    expect(res.safety).toHaveLength(2);
    expect(res.safety[0]!.text).toBe("Do not use with active bleeding.");
  });

  it("extracts text from a real .pdf — one block per page (whole document, not just page one)", async () => {
    expect(isPdf("brief.PDF")).toBe(true);
    expect(isPdf("deck.pptx")).toBe(false);
    const bytes = buildPdf([
      "Milvexian is an investigational Factor XIa inhibitor.",
      "LIBREXIA Phase 3 program under study.",
    ]);
    const text = await extractSourceText("brief.pdf", bytes);
    // Both pages present (whole doc), page markers stripped, page boundaries preserved.
    expect(text).toContain("Milvexian is an investigational Factor XIa inhibitor.");
    expect(text).toContain("LIBREXIA Phase 3 program under study.");
    expect(text).not.toMatch(/of \d+ --/);
    const blocks = parseBlocks(text);
    expect(blocks).toHaveLength(2);
    // Each PDF page becomes its own approved-answer + detail-aid slide.
    const res = ingestSource({ kind: "pdf", title: "Brief", text, mlr }, "pdf1");
    expect(res.answers).toHaveLength(2);
    expect(res.slides).toHaveLength(2);
  }, 30_000);

  it("rejects an unsupported file type with a helpful message", async () => {
    await expect(extractSourceText("notes.docx", new Uint8Array([1, 2, 3]))).rejects.toThrow(/supported: .pptx, .pdf/);
  });
});
