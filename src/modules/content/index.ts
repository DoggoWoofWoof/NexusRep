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
export { getComposer, resolveComposer, composeGreeting, compactCoaching, type GroundedComposer, type ComposeInput } from "./composer";
export { PresentationSkill, type PresentationAction, type PresentationRequest, type PresentationStep } from "./presentation";
