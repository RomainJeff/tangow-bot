import type {
  GuestBody,
  GuestRunInput,
  HarnessDeclaration,
  ReplyFinal,
  ReplyPart,
  WorkerIdentity,
} from "@tangow/adapter-kit";

export type InformativeBody = Extract<
  GuestBody,
  { type: "text" | "progress" | "tool" | "subagent" }
>;
export type DoneBody = Extract<GuestBody, { type: "done" }>;

/** What the guest gives a harness: the channel to its controller, already sequenced and bounded. */
export interface HarnessHost {
  /** Aborted when the controller cancels the run or the channel is gone for good. */
  readonly signal: AbortSignal;
  /** Text, progress, tool announcements and helper status. Resolves once the window has room. */
  emit(body: InformativeBody): Promise<void>;
  /**
   * A frame the controller decides. A refusal or an `error` reply throws. A frame that needs a
   * capability the harness did not declare throws before it is sent.
   */
  decide<T extends ReplyFinal["type"]>(
    body: GuestBody,
    expected: T,
  ): Promise<Extract<ReplyFinal, { type: T }>>;
  /** A model call in the harness's dialect; events arrive through `onPart` in order. */
  model(
    body: Extract<GuestBody, { type: "model.request" }>,
    onPart: (part: ReplyPart) => void,
    signal?: AbortSignal,
  ): Promise<ReplyFinal>;
  /**
   * One call of a controller tool; resolves with its output. Must follow the `tool` announcement
   * of the same `callId`. The controller refuses a call of the harness's own tools.
   */
  callTool(
    agent: string,
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<unknown>;
  /** A controller call paused the run on the person: the harness only closes its turn. */
  paused(): boolean;
}

/**
 * An agent harness the guest can run. It turns its own loop into neutral frames through the host
 * and holds no key: its model calls go through `host.model`. One is implemented, in `harness/`.
 */
export interface GuestHarness {
  readonly declaration: HarnessDeclaration;
  /** Runs the attempt; resolves with its final words, which the controller decides to accept. */
  run(
    start: {
      worker: WorkerIdentity;
      run: GuestRunInput;
      cwd: string;
      skillsDir: string;
      /** Authorized private mount root; absent for runs without a private volume. */
      outputRoot?: string;
      /** Controller-assigned helper ref; omitted for the root session. */
      agent?: string;
    },
    host: HarnessHost,
  ): Promise<DoneBody>;
}
