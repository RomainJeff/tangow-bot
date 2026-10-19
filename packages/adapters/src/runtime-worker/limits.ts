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
  /**
   * The controller re-truncates a command's text before recording it. A result object is bounded
   * by `guestFrameBytes`, like the same tool's result in process.
   */
  controllerResultBytes: 64 * KiB,
  /** Covers a cold boot. Checked once, at `worker.hello`. */
  capabilityTtlMs: 10 * 60_000,
  helloDeadlineMs: 30_000,
  cancelGraceMs: 2_000,
  stopConfirmMs: 10_000,
  modelRequestsPerAttempt: 400,
} as const;
