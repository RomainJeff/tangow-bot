import { AskQuestion, ModelCategorySchema, VolumeAccess, WorkerState } from "@rakazo/contracts";
import { z } from "zod";
import {
  RunReceiptSchema,
  RunResumeEventSchema,
  RunSnapshotSchema,
  RunStartSchema,
} from "./run-snapshot.js";

/** Every wire message carries it. A peer of another version is refused, never coerced. */
export const WORKER_PROTOCOL_VERSION = 2;

/** Every message names one run attempt and the fence it claimed. */
export const WorkerIdentitySchema = z.strictObject({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  fence: z.number().int().positive(),
});
export type WorkerIdentity = z.infer<typeof WorkerIdentitySchema>;

export function sameWorker(a: WorkerIdentity, b: WorkerIdentity): boolean {
  return a.runId === b.runId && a.attemptId === b.attemptId && a.fence === b.fence;
}

/** What the guest learns about a mount: where and how. Never which volume, owner or host path. */
export const GuestMountSchema = z.strictObject({
  path: z.string().startsWith("/"),
  scope: z.enum(["private", "shared"]),
  access: VolumeAccess,
});
export type GuestMount = z.infer<typeof GuestMountSchema>;

const JsonRecord = z.record(z.string(), z.unknown());
const Id = z.string().min(1).max(256);
const Seq = z.number().int().positive();

const ImageSchema = z.strictObject({
  name: z.string(),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  /** Base64. */
  data: z.string(),
});
export type GuestImage = z.infer<typeof ImageSchema>;

/** A model the guest may name and size its prompts for. It never carries a key or an endpoint. */
export const GuestModelSchema = z.strictObject({
  provider: z.string().min(1),
  id: z.string().min(1),
  reasoning: z.boolean().optional(),
  acceptsImages: z.boolean().optional(),
  maxImagesPerPrompt: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  contextWindow: z.number().int().positive().optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
});
export type GuestModel = z.infer<typeof GuestModelSchema>;

/** `guest` tools are the harness's own, run by its loop in the VM; `controller` tools are Rakazo's. */
export const ToolPlacement = z.enum(["controller", "guest"]);
export type ToolPlacement = z.infer<typeof ToolPlacement>;

const GuestToolSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: JsonRecord,
  readOnly: z.boolean().optional(),
  where: ToolPlacement,
  /**
   * A large connector catalog. `fallback` marks the tools that search, load and run it by id, for a
   * harness without native tool search. An entry is one of its tools: a harness with native tool
   * search declares it once found, and runs it as `via` with `{ id, arguments }`.
   */
  catalog: z
    .union([
      z.literal("fallback"),
      z.strictObject({ via: z.string().min(1), id: z.string().min(1) }),
    ])
    .optional(),
});
export type GuestTool = z.infer<typeof GuestToolSchema>;

const HistoryTurnSchema = z.strictObject({
  id: z.string().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  parts: z
    .array(
      z.union([
        z.strictObject({ type: z.literal("text"), text: z.string() }),
        z.strictObject({
          type: z.literal("toolCalls"),
          calls: z.array(
            z.strictObject({
              id: z.string(),
              name: z.string(),
              args: JsonRecord,
              output: z.string(),
            }),
          ),
        }),
      ]),
    )
    .optional(),
});

/** Everything a guest harness needs to run the attempt, as data: no callback, secret, key or route. */
export const GuestRunInputSchema = z.strictObject({
  start: RunStartSchema.optional(),
  resumeEvent: z.string().optional(),
  resumeEvents: z.array(RunResumeEventSchema).optional(),
  botId: Id,
  threadId: Id,
  sourceMessageId: z.string().nullish(),
  prompt: z.string(),
  instructions: z.string(),
  history: z.array(HistoryTurnSchema),
  images: z.array(ImageSchema),
  tools: z.array(GuestToolSchema),
  model: GuestModelSchema,
  allowSilentEmpty: z.boolean().optional(),
  freeTextIsPrivate: z.boolean().optional(),
  runRecap: z.boolean().optional(),
  emptyResponseText: z.string().optional(),
});
export type GuestRunInput = z.infer<typeof GuestRunInputSchema>;

/**
 * Model-access dialects. A guest harness asks the controller for model calls in one dialect; the
 * controller runs them with its own model, key and reasoning level and streams the dialect's
 * events back. The run channel, the capability, the authorization, the request caps and the usage
 * accounting are the same for every dialect. One is implemented: `pi-ai`, pi-ai's transcript and
 * stream events. A dialect for an HTTP-compatible model endpoint would be a second member here and
 * a second relay in the controller.
 */
export const ModelDialect = z.enum(["pi-ai"]);
export type ModelDialect = z.infer<typeof ModelDialect>;

/** A `pi-ai` model call: the transcript, tool declarations included, as the harness shaped it. */
export const PiAiModelCallSchema = z.strictObject({
  context: z.strictObject({
    messages: z.array(
      z.looseObject({ role: z.enum(["system", "user", "assistant", "toolResult"]) }),
    ),
  }),
  options: z.strictObject({ sessionId: z.string().max(512).optional() }),
});
export type PiAiModelCall = z.infer<typeof PiAiModelCallSchema>;

const ContentIndex = z.number().int().nonnegative();
/** One event of a relayed response: pi-ai's stream event minus the growing `partial`. */
export const PiAiModelEventSchema = z.union([
  z.strictObject({ type: z.literal("start"), partial: JsonRecord }),
  z.strictObject({
    type: z.enum(["text_start", "thinking_start", "toolcall_start"]),
    contentIndex: ContentIndex,
    block: JsonRecord,
  }),
  z.strictObject({
    type: z.enum(["text_delta", "thinking_delta", "toolcall_delta"]),
    contentIndex: ContentIndex,
    delta: z.string(),
  }),
  z.strictObject({
    type: z.enum(["text_end", "thinking_end"]),
    contentIndex: ContentIndex,
    content: z.string(),
  }),
  z.strictObject({
    type: z.literal("toolcall_end"),
    contentIndex: ContentIndex,
    toolCall: JsonRecord,
  }),
  z.strictObject({
    type: z.literal("done"),
    reason: z.enum(["stop", "length", "toolUse", "deferred"]),
    message: JsonRecord,
  }),
  z.strictObject({
    type: z.literal("error"),
    reason: z.enum(["aborted", "error"]),
    error: JsonRecord,
  }),
]);
export type PiAiModelEvent = z.infer<typeof PiAiModelEventSchema>;

/**
 * Guest to controller. `text`, `progress`, `tool` and `subagent` are informative: their reply is
 * a flow-control `ack`. Every other body asks the controller to decide or to persist, and its
 * reply is that decision. Usage, provider, connection and owner choices have no body: the
 * controller measures or decides them.
 */
export const WorkerSkillSchema = z.strictObject({
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(1024),
  source: z.enum(["managed", "bot", "shared"]),
  path: z.string().max(4096),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  content: z.string().max(100_000),
  files: z
    .array(z.strictObject({ path: z.string().max(4096), content: z.string().max(100_000) }))
    .max(128),
});
export type WorkerSkill = z.infer<typeof WorkerSkillSchema>;
export const SkillCollisionSchema = z.strictObject({
  name: z.string().max(80),
  kept: z.enum(["managed", "bot", "shared"]),
  ignored: z.enum(["managed", "bot", "shared"]),
});
export type SkillCollision = z.infer<typeof SkillCollisionSchema>;

export const GuestBodySchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot.save"), snapshot: RunSnapshotSchema }),
  z.strictObject({ type: z.literal("snapshot.resolve") }),
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("progress"),
    text: z.string(),
    activity: z.literal(true).optional(),
  }),
  z.strictObject({ type: z.literal("tool"), name: z.string(), args: JsonRecord, executionId: Id }),
  z.strictObject({
    type: z.literal("subagent"),
    agentId: Id,
    name: z.string(),
    task: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    progress: z.string().optional(),
    result: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("model.request"),
    /** `root`, or the helper ref the controller returned in `subagent.opened`. */
    agent: Id,
    dialect: ModelDialect,
    call: PiAiModelCallSchema,
  }),
  /** Guest-local duration, never a cross-machine timestamp. Diagnostic only. */
  z.strictObject({
    type: z.literal("model.latency"),
    re: Seq,
    firstEventMs: z.number().finite().nonnegative(),
  }),
  /** Stop streaming the reply to the model request `re`. */
  z.strictObject({ type: z.literal("model.abort"), re: Seq }),
  z.strictObject({
    type: z.literal("tool.call"),
    agent: Id,
    callId: Id,
    name: z.string(),
    args: JsonRecord,
  }),
  z.strictObject({ type: z.literal("steering.claim"), seenIds: z.array(Id) }),
  z.strictObject({
    type: z.literal("subagent.open"),
    callId: Id,
    name: z.string(),
    task: z.string(),
    args: JsonRecord,
    category: ModelCategorySchema,
  }),
  z.strictObject({ type: z.literal("subagent.text"), agent: Id, text: z.string() }),
  z.strictObject({
    type: z.literal("subagent.finish"),
    agent: Id,
    status: z.enum(["completed", "failed"]),
    result: z.string(),
  }),
  z.strictObject({ type: z.literal("subagent.abandon"), agent: Id, result: z.string() }),
  z.strictObject({
    type: z.literal("ask"),
    text: z.string(),
    detail: z.string().optional(),
    actions: z.array(z.strictObject({ id: z.string(), label: z.string() })).optional(),
    questions: z.array(AskQuestion).optional(),
  }),
  z.strictObject({ type: z.literal("takeover"), reason: z.string() }),
  z.strictObject({
    type: z.literal("done"),
    text: z.string().optional(),
    privateFinalText: z.string().optional(),
    runtimeNotice: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("skills.index"), skill: WorkerSkillSchema }),
  z.strictObject({ type: z.literal("skills.collision"), collision: SkillCollisionSchema }),
  z.strictObject({ type: z.literal("skills.used"), name: z.string().min(1).max(80) }),
  z.strictObject({
    type: z.literal("skills.index.end"),
    sources: z.array(z.enum(["managed", "bot", "shared"])).max(3),
  }),
  z.strictObject({ type: z.literal("failed"), message: z.string() }),
  /**
   * A harness that runs its own loop reports each message of its native session as it ends, in
   * its model-access dialect, before acting on it. The controller ingests them into canonical
   * history; it never trusts the results the harness claims for controller tools.
   */
  z.strictObject({
    type: z.literal("transcript"),
    /** The session it reports: the root's when left out, else a helper the controller opened. */
    agent: Id.optional(),
    dialect: ModelDialect,
    messages: z.array(z.looseObject({ role: z.string().min(1).max(64) })).max(4096),
  }),
]);
export type GuestBody = z.infer<typeof GuestBodySchema>;

/** Why the controller ended a channel. A refused request is never retried on that channel. */
export const RefusalReason = z.enum([
  "invalid",
  "version",
  "capability",
  "identity",
  "sequence",
  "window",
  "too_large",
  "unknown_tool",
  "revoked",
  "budget",
  /** The frame needs a harness capability the hello did not declare. */
  "undeclared",
]);
export type RefusalReason = z.infer<typeof RefusalReason>;

/** A reply that more parts follow. */
export const ReplyPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("model.event"), event: PiAiModelEventSchema }),
  /** `done` arrived while these calls were still open: the run ends only once they settle. */
  z.strictObject({ type: z.literal("end.refused"), pending: z.array(Id) }),
  /**
   * On a `run_subagent` call from a `native-loop` harness: run this helper as a session of its own,
   * its frames named `agent`, until `subagent.finish`. The call settles with the helper's result.
   */
  z.strictObject({ type: z.literal("subagent.start"), agent: Id, run: GuestRunInputSchema }),
]);
export type ReplyPart = z.infer<typeof ReplyPartSchema>;

/** The reply that settles a guest frame. */
export const ReplyFinalSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("snapshot.receipts"), receipts: z.array(RunReceiptSchema) }),
  z.strictObject({ type: z.literal("ack") }),
  z.strictObject({ type: z.literal("model.end") }),
  /** A controller-run tool, already executed and logged. */
  z.strictObject({ type: z.literal("tool.result"), output: z.unknown() }),
  z.strictObject({
    type: z.literal("steering"),
    messages: z.array(
      z.strictObject({
        id: Id,
        messageId: Id,
        text: z.string(),
        historyText: z.string().optional(),
        images: z.array(ImageSchema).optional(),
      }),
    ),
  }),
  z.strictObject({ type: z.literal("subagent.opened"), agent: Id, model: GuestModelSchema }),
  z.strictObject({ type: z.literal("recorded") }),
  z.strictObject({ type: z.literal("stop"), reason: z.enum(["done", "paused", "cancelled"]) }),
  /** The controller's callback failed; the guest's callback throws this message. */
  z.strictObject({ type: z.literal("error"), message: z.string() }),
  z.strictObject({ type: z.literal("refused"), reason: RefusalReason }),
]);
export type ReplyFinal = z.infer<typeof ReplyFinalSchema>;
export type ReplyBody = ReplyPart | ReplyFinal;

/** Controller to guest, once the worker is ready. */
export const WorkerStartV1Schema = z.strictObject({
  version: z.literal(WORKER_PROTOCOL_VERSION),
  kind: z.literal("worker.start"),
  worker: WorkerIdentitySchema,
  workspace: z.strictObject({
    cwd: z.string().startsWith("/"),
    mounts: z.array(GuestMountSchema).max(2),
  }),
  computer: z.enum(["none", "on_use"]),
  run: GuestRunInputSchema,
});
export type WorkerStartV1 = z.infer<typeof WorkerStartV1Schema>;

/** Controller to guest: stop the run. The controller destroys the VM whatever the guest does. */
export const WorkerCancelV1Schema = z.strictObject({
  version: z.literal(WORKER_PROTOCOL_VERSION),
  kind: z.literal("worker.cancel"),
  worker: WorkerIdentitySchema,
});
export type WorkerCancelV1 = z.infer<typeof WorkerCancelV1Schema>;

/** Controller to guest: one part of the reply to the guest frame `re`, numbered from 0. */
export const WorkerReplyV1Schema = z.strictObject({
  version: z.literal(WORKER_PROTOCOL_VERSION),
  kind: z.literal("worker.reply"),
  worker: WorkerIdentitySchema,
  payload: z.strictObject({
    re: Seq,
    part: z.number().int().nonnegative(),
    body: z.union([ReplyPartSchema, ReplyFinalSchema]),
  }),
});
export type WorkerReplyV1 = z.infer<typeof WorkerReplyV1Schema>;

/** The controller's view of a worker, read from the database. Never on the wire. */
export const WorkerStatusV1Schema = z.strictObject({
  version: z.literal(WORKER_PROTOCOL_VERSION),
  kind: z.literal("worker.status"),
  worker: WorkerIdentitySchema,
  state: WorkerState,
  providerRef: z.string().nullable(),
  active: z.boolean(),
});
export type WorkerStatusV1 = z.infer<typeof WorkerStatusV1Schema>;

/**
 * What a guest harness can do beyond the core run: text, tools, questions, model calls. The
 * controller refuses a frame that needs a capability its harness did not declare, and offers no
 * tool that needs one.
 */
/** `native-loop`: the harness runs its own loop, prompt and tools, and reports a transcript. */
export const HarnessCapability = z.enum(["subagents", "steering", "native-loop", "resume"]);
export type HarnessCapability = z.infer<typeof HarnessCapability>;

/** The guest frames a harness may send only with the capability it declared. */
export const FRAME_CAPABILITY: Readonly<Partial<Record<GuestBody["type"], HarnessCapability>>> = {
  subagent: "subagents",
  "subagent.open": "subagents",
  "subagent.text": "subagents",
  "subagent.finish": "subagents",
  "subagent.abandon": "subagents",
  "steering.claim": "steering",
  transcript: "native-loop",
  "snapshot.save": "resume",
  "snapshot.resolve": "resume",
};

/** The guest harness: which one runs the attempt, and its declared capabilities. */
export const HarnessDeclarationSchema = z.strictObject({
  name: z.string().min(1).max(64),
  capabilities: z.array(HarnessCapability).max(HarnessCapability.options.length),
});
export type HarnessDeclaration = z.infer<typeof HarnessDeclarationSchema>;

/** Guest to controller, first on every connection: the capability it was launched with. */
export const WorkerHelloV1Schema = z.strictObject({
  version: z.literal(WORKER_PROTOCOL_VERSION),
  kind: z.literal("worker.hello"),
  worker: WorkerIdentitySchema,
  capability: z.string().max(1024),
  harness: HarnessDeclarationSchema,
});
export type WorkerHelloV1 = z.infer<typeof WorkerHelloV1Schema>;

/** Guest to controller. Frames are numbered from 1 and resent unchanged after a reconnect. */
export const WorkerEventV1Schema = z.strictObject({
  version: z.literal(WORKER_PROTOCOL_VERSION),
  kind: z.literal("worker.event"),
  worker: WorkerIdentitySchema,
  payload: z.strictObject({ seq: Seq, body: GuestBodySchema }),
});
export type WorkerEventV1 = z.infer<typeof WorkerEventV1Schema>;

/** What the controller accepts from a guest. */
export const GuestMessageV1Schema = z.discriminatedUnion("kind", [
  WorkerHelloV1Schema,
  WorkerEventV1Schema,
]);
export type GuestMessageV1 = z.infer<typeof GuestMessageV1Schema>;

/** What a guest accepts from the controller. */
export const ControllerMessageV1Schema = z.discriminatedUnion("kind", [
  WorkerStartV1Schema,
  WorkerCancelV1Schema,
  WorkerReplyV1Schema,
]);
export type ControllerMessageV1 = z.infer<typeof ControllerMessageV1Schema>;

export type WireParse<T> =
  | { ok: true; message: T }
  | { ok: false; reason: "unsupported_version" | "invalid" };

/** Never throws: a message from a newer or hostile peer is refused, not coerced. */
function parseWire<T>(schema: z.ZodType<T>, json: unknown): WireParse<T> {
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data };
  const version =
    typeof json === "object" && json !== null && "version" in json ? json.version : undefined;
  return {
    ok: false,
    reason:
      version !== undefined && version !== WORKER_PROTOCOL_VERSION
        ? "unsupported_version"
        : "invalid",
  };
}

export function parseGuestMessage(json: unknown): WireParse<GuestMessageV1> {
  return parseWire(GuestMessageV1Schema, json);
}

export function parseControllerMessage(json: unknown): WireParse<ControllerMessageV1> {
  return parseWire(ControllerMessageV1Schema, json);
}

type NoFunctions<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends object
    ? { [K in keyof T]: NoFunctions<T[K]> }
    : T;
type WireMessageV1 = GuestMessageV1 | ControllerMessageV1;
// Fails to compile once any message field can hold a callable.
const _wireCarriesNoCallable: WireMessageV1 extends NoFunctions<WireMessageV1> ? true : never =
  true;
