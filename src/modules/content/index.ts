export * from "./types";
export {
  ContentService,
  type SourceValidationContext,
  type SourceValidationError,
} from "./service";
export { ingestSource, parseBlocks, extractSourceText, type RawSource, type IngestResult } from "./ingest";
export { parsePptx, isPptx } from "./parsers/pptx";
export { parsePdf, isPdf } from "./parsers/pdf";
export { buildApprovedResponse, slideReference, type BuiltResponse } from "./responseBuilder";
// NOTE: isOverviewPrompt is intentionally NOT re-exported here. This barrel pulls in server-only
// parsers (node:fs / node:path via pptx/pdf/ingest), so CLIENT components must import the client-safe
// leaf `@modules/content/overviewPrompt` directly rather than this barrel.
export { getComposer, resolveComposer, firstAvailableComposer, defaultComposer, withUsageLedger, composeGreeting, compactCoaching, llmComplete, type GroundedComposer, type ComposeInput } from "./composer";
export {
  mergePlan,
  PresentationSkill,
  type PresentationAction,
  type PresentationDeckSlide,
  type PresentationPlan,
  type PresentationPlanStep,
  type PresentationRequest,
  type PresentationStep,
} from "./presentation";
