import { mockResponder } from "./mock";
import { claudeResponder, openaiResponder, thinkingMachinesResponder } from "./llm";
import type { Responder } from "./types";

export type { Responder } from "./types";

export const RESPONDERS: Responder[] = [
  mockResponder,
  claudeResponder,
  openaiResponder,
  thinkingMachinesResponder,
];

export function getResponder(name: string): Responder | undefined {
  return RESPONDERS.find((r) => r.name === name);
}

/** Provider availability list, for the Arena UI's selector. */
export function listResponders(): { name: string; label: string; available: boolean }[] {
  return RESPONDERS.map((r) => ({ name: r.name, label: r.label, available: r.available() }));
}
