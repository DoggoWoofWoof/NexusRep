/**
 * Real PowerPoint (.pptx) text extractor. A .pptx is an Office Open XML package
 * (a ZIP of XML parts); slide text lives in <a:t> runs inside
 * ppt/slides/slideN.xml. We unzip with JSZip, pull each slide's runs in slide
 * order, and return one plain-text string per slide.
 *
 * This produces the same "text" the deterministic ingest normalizer already
 * consumes (one block per slide), so nothing downstream changes — the parser is
 * a real implementation of the same contract the mock used to fill by hand.
 */

import JSZip from "jszip";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(s: string): string {
  return s.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, (m) => ENTITIES[m] ?? m);
}

function slideNumber(name: string): number {
  const m = name.match(/slide(\d+)\.xml$/);
  return m ? parseInt(m[1]!, 10) : 0;
}

/** Extract slide texts from a .pptx buffer, in slide order. One string per slide. */
export async function parsePptx(data: ArrayBuffer | Uint8Array): Promise<string[]> {
  const zip = await JSZip.loadAsync(data);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.files[name]!.async("string");
    const runs = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)).map((m) => decodeXml(m[1] ?? ""));
    const text = runs.join(" ").replace(/\s+/g, " ").trim();
    if (text) slides.push(text);
  }
  return slides;
}

/** True if the filename looks like a PowerPoint deck we can parse. */
export function isPptx(filename: string): boolean {
  return filename.toLowerCase().endsWith(".pptx");
}
