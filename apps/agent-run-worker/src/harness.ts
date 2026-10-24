import type {
  ConnectorTool,
  GuestBody,
  GuestRunInput,
  HarnessDeclaration,
  LocalToolOutput,
  ReplyFinal,
  ReplyPart,
  WorkerIdentity,
} from "@rakazo/adapter-kit";

export type InformativeBody = Extract<
  GuestBody,
  { type: "text" | "progress" | "tool" | "subagent" }
>;
export type DoneBody = Extract<GuestBody, { type: "done" }>;

/** How a tool call ended: run by the controller, or granted and run here. */
export type ToolCallOutcome =
  | { placement: "controller"; output: unknown }
  | { placement: "guest"; output: LocalToolOutput };

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
  /** One tool call. Must follow the `tool` announcement of the same `callId`. */
  callTool(
    agent: string,
    name: string,
    args: Record<string, unknown>,
    callId: string,
  ): Promise<ToolCallOutcome>;
}

export interface NativeToolContext {
  cwd: string;
  spoolDir: string;
  signal: AbortSignal;
}

/**
 * An agent harness the guest can run. It turns its own loop into neutral frames through the host
 * and holds no key: its model calls go through `host.model`. One is implemented, in `harness/`.
 */
export interface GuestHarness {
  readonly declaration: HarnessDeclaration;
  readonly nativeTools: readonly ConnectorTool[];
  executeNativeTool(
    name: string,
    args: Record<string, unknown>,
    callId: string,
    context: NativeToolContext,
  ): Promise<LocalToolOutput>;
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
