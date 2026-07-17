/**
 * Realtime module surface (brief §18–19). Owns runtime-turn orchestration and
 * realtime provider access. The A/V provider is resolved through @modules/vendors
 * and stays behind the RealtimeProvider interface — orchestration (and therefore
 * the compliance gate) stays in our code regardless of provider.
 */

export { TurnOrchestrator, type TurnContext, type TurnOutput } from "./orchestrator";
export { ConversationService, type ConversationDeps, type TurnOpts } from "./conversation";
export {
  runScriptedSession,
  type ScriptLine,
  type SpikeDeps,
  type SpikeEvent,
  type SpikeEventKind,
  type SpikeTimeline,
} from "./avSpike";
export { getRealtimeProvider } from "@modules/vendors";
export { RESPONDERS, getResponder, listResponders, type Responder } from "./responders";
export {
  FRAGMENT_WINDOW_MS,
  isLikelyIncompleteFragment,
  isLikelyFragmentContinuation,
  mergeOrBufferFragment,
  shouldIgnoreTrailingRecoveredFragment,
  markRecoveredFragmentWindow,
  rememberRecoveredFragmentReply,
  getRecoveredFragmentReply,
  waitForRecoveredFragmentReply,
} from "./fragment-buffer";
