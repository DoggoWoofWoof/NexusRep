export * from "./types";
export {
  ContentService,
  type SourceValidationContext,
  type SourceValidationError,
} from "./service";
export { ingestSource, parseBlocks, extractSourceText, type RawSource, type IngestResult } from "./ingest";
export { parsePptx, isPptx } from "./parsers/pptx";
export { parsePdf, isPdf } from "./parsers/pdf";
export { buildApprovedResponse, slideReference, weaveSlideCueEarly, type BuiltResponse } from "./responseBuilder";
export { getComposer, resolveComposer, firstAvailableComposer, defaultComposer, composeGreeting, compactCoaching, llmComplete, type GroundedComposer, type ComposeInput } from "./composer";
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
