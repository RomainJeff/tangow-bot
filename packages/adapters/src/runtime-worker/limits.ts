import type { AgentRunModel } from "@rakazo/adapter-kit";
import { DEFAULT_MODEL_MAX_TOKENS, MAX_MODEL_CONTEXT_WINDOW } from "@rakazo/contracts";
import { TOOL_RESULT_TEXT_LIMIT } from "../pi-runtime-limits.js";

const KiB = 1024;
const MiB = 1024 * KiB;

/** Published bounds of the worker channel. The guest is hostile: every one is enforced at the controller. */
export const WORKER_LIMITS = {
  /** Guest frame, any body but `model.request`. */
  guestFrameBytes: 1 * MiB,
  /** A `model.request` carries the whole transcript. Also the length-prefix cap of guest frames. */
  modelRequestBytes: 8 * MiB,
  /** Controller frame: the start input with prompt images. */
  controllerFrameBytes: 8 * MiB,
  /** Guest frames sent and not yet replied to. A frame beyond it is a violation. */
  inflightFrames: 32,
  /** Bytes of those frames the guest holds for resending. A lone larger frame still goes. */
  inflightBytes: 4 * MiB,
  /** Settled replies the controller keeps to answer a resent frame. At least the window. */
  replyCache: 64,
  /** Guest text is sent once this much is buffered, or after textFlushMs. */
  textFlushBytes: 4 * KiB,
  textFlushMs: 50,
  toolArgsBytes: 256 * KiB,
  /**
   * What a guest tool shows the model, head and tail. The implemented harness shows the model at
   * most this many characters of any tool result, so a longer text would lose its tail and marker.
   */
  localOutputModelChars: TOOL_RESULT_TEXT_LIMIT,
  localOutputModelLines: 2000,
  /** Per command, on the guest disk only; capture stops past it. */
  localOutputSpoolBytes: 16 * MiB,
  /**
   * Spool files kept in the spool directory, which may sit on a persistent volume: the oldest go
   * before a new one is written. With the per-command cap, at most 256 MiB.
   */
  localOutputSpoolFiles: 16,
  /** The controller re-truncates a command's text before recording it. */
  controllerResultBytes: 64 * KiB,
  /**
   * A guest tool's result object, serialized. A larger one is returned to the model as an error
   * instead, so it never reaches `guestFrameBytes`, which would end the run.
   */
  localResultBytes: 512 * KiB,
  /** A helper's model requests, counted apart from its parent's and within the attempt's. */
  modelRequestsPerHelper: 100,
  /** Covers a cold boot. Checked once, at `worker.hello`. */
  capabilityTtlMs: 10 * 60_000,
  helloDeadlineMs: 30_000,
  cancelGraceMs: 2_000,
  stopConfirmMs: 10_000,
  modelRequestsPerAttempt: 400,
  /** Controller tool calls across the root and its helpers, including native authorizations. */
  toolCallsPerAttempt: 2_000,
  /** Model requests a paused attempt may still make to close its turn; later ones are turned away. */
  pausedModelRequests: 2,
  /** Tool calls a paused attempt may still make, each answered without running. */
  pausedToolCalls: 32,
  /** A paused attempt that does not conclude ends after this long. */
  pausedGraceMs: 60_000,
} as const;

/**
 * No provider-neutral cache price exists. Allow a full prompt plus its output on all 400 calls:
 * attempt tokens = modelTokensPerRequest(model) * modelRequestsPerAttempt. When context metadata
 * is absent, the shared maximum avoids cutting catalog models short. This is a runaway guard.
 * Controller-side history compaction is billed separately and deliberately outside the attempt budget.
 */
export function modelTokensPerRequest(model: AgentRunModel): number {
  return (
    (model.contextWindow ?? MAX_MODEL_CONTEXT_WINDOW) +
    (model.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS)
  );
}
