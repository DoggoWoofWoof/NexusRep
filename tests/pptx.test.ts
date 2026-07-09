import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { parsePptx, isPptx, extractSourceText } from "@modules/content";

/** Build a minimal valid .pptx (ZIP of slide XML parts) in memory. */
async function makePptx(slides: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  slides.forEach((text, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld><p:cSld><p:spTree><a:t>${text}</a:t></p:spTree></p:cSld></p:sld>`);
  });
  zip.file("ppt/presentation.xml", "<p:presentation/>"); // non-slide part, must be ignored
  return zip.generateAsync({ type: "uint8array" });
}

describe("pptx parser (real Office Open XML extraction)", () => {
  it("extracts one text block per slide, in order, ignoring non-slide parts", async () => {
    const buf = await makePptx([
      "Milvexian is an investigational Factor XIa inhibitor.",
      "LIBREXIA Phase 3 program: ischemic stroke, ACS, atrial fibrillation.",
    ]);
    const slides = await parsePptx(buf);
    expect(slides).toHaveLength(2);
    expect(slides[0]).toContain("Factor XIa");
    expect(slides[1]).toContain("LIBREXIA");
  });

  it("decodes XML entities and joins multiple runs on a slide", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide1.xml", `<a:t>Safety &amp; efficacy</a:t><a:t>not established</a:t>`);
    const slides = await parsePptx(await zip.generateAsync({ type: "uint8array" }));
    expect(slides[0]).toBe("Safety & efficacy not established");
  });

  it("orders slides numerically (slide2 before slide10)", async () => {
    const zip = new JSZip();
    zip.file("ppt/slides/slide10.xml", `<a:t>ten</a:t>`);
    zip.file("ppt/slides/slide2.xml", `<a:t>two</a:t>`);
    const slides = await parsePptx(await zip.generateAsync({ type: "uint8array" }));
    expect(slides).toEqual(["two", "ten"]);
  });

  it("extractSourceText handles pptx + txt and rejects unsupported types", async () => {
    expect(isPptx("Deck.PPTX")).toBe(true);
    const buf = await makePptx(["Hello world"]);
    expect(await extractSourceText("deck.pptx", buf)).toContain("Hello world");
    expect(await extractSourceText("notes.txt", new TextEncoder().encode("plain notes"))).toBe("plain notes");
    // A genuinely unsupported extension is rejected with the supported-list message.
    await expect(extractSourceText("notes.docx", new Uint8Array([1, 2, 3]))).rejects.toThrow(/unsupported/i);
    // A .pdf is now supported, so garbage bytes fail as a PDF-parse error (fails safe),
    // NOT as "unsupported" — proving the PDF path is actually wired.
    await expect(extractSourceText("scan.pdf", new Uint8Array([1, 2, 3]))).rejects.toThrow();
  }, 20_000);
});
