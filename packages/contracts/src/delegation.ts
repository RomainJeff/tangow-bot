import * as z from "zod";
import type {
  HarnessChoice,
  SpecialistHarnessFallbackCause,
  SpecialistHarnessSource,
} from "./harness-choice.js";
import {
  HarnessChoiceSchema,
  SPECIALIST_HARNESS_FALLBACK_CAUSES,
  SPECIALIST_HARNESS_SOURCES,
} from "./harness-choice.js";
import { Id } from "./ids.js";

// T04: public delegation contract (PA-CONTRAT-CONVERGENCE.md §6, symbols fixed before T01).
// WorkTarget deliberately has one variant only: ADR-0001/ADR-0002 reserve scoped_tasks
// for the from_profile specialist; delegating to an existing_bot stays a PeerMessage.

export type ScopedWorkId = string; // = scoped_tasks.id ; never Bot.id nor Task.id

export type WorkTarget = { kind: "from_profile"; profileBotId: string; name: string };

export type RightsSubset = Record<string, boolean>;

/**
 * T07:4 correction (Terra review B3): the real, currently-existing per-bot permission
 * surface is an MCP connector assignment, and it is granular per tool
 * (`BotMcpServer.allowAllTools`/`allowedTools`), not a single boolean per server — a
 * boolean-per-server `RightsSubset` cannot represent "this server, but only these tools".
 * `delegationCeiling` is keyed by `serverId`.
 */
export type McpServerAccess = { allowAllTools: boolean; allowedTools: string[] };
export type McpAccessCeiling = Record<string, McpServerAccess>;

export type DelegationCommand =
  | {
      kind: "delegate";
      target: WorkTarget;
      /**
       * The harness the coordinator asks for; `default` is Rakazo's own. Absent, the profile's
       * choice when it was ever set, then a judgment among the available harnesses, then the
       * coordinator's own harness decide. Always the task's Computer of mission, never a
       * caller-named target.
       */
      harness?: HarnessChoice;
      brief: string;
      /**
       * T07:6 (B5, root decision): a request for a ceiling *narrower* than the coordinator's
       * own effective MCP access, never a way to widen it. Empty (`{}`, still the only shape
       * `executor.ts` sends today): the ceiling becomes the coordinator's full effective
       * access. Non-empty: the ceiling becomes `requestedRights ∩ coordinator's effective
       * access`, per server, tool by tool — and a request that exceeds what the coordinator
       * actually holds (a server it doesn't have, `allowAllTools` it doesn't have, or a tool
       * outside its own list) is refused outright (`RightsExceededError`), never silently
       * truncated to what the coordinator holds.
       */
      requestedRights: McpAccessCeiling;
      spawnKey: string;
    }
  | { kind: "followup"; workId: ScopedWorkId; text: string }
  | { kind: "cancel"; workId: ScopedWorkId; reason: string }
  | {
      kind: "close";
      workId: ScopedWorkId;
      /** The user, not the coordinator bot, decided the closure; the durable event says so. */
      decidedBy?: "user";
    };

export type AuthorizedActor = {
  userId: string;
  spaceId: string;
  botId: string;
  rights: RightsSubset;
};

export type CommandContext = {
  actor: AuthorizedActor;
  originRunId: string;
  requestId: string;
  /** Computer actually serving the coordinator turn; ownership remains on Bot.computerId. */
  missionComputerId?: string;
};

export type Receipt = {
  workId: ScopedWorkId;
  botId: string;
  threadId: string;
  runId?: string;
  state: "queued" | "cancelling" | "closed";
  replayed: boolean;
};

/** How a specialist Run ended, as the coordinator and the work_return card read it. */
export const WORK_RETURN_OUTCOMES = ["result", "failed", "cancelled", "no_result"] as const;
export type WorkReturnOutcome = (typeof WORK_RETURN_OUTCOMES)[number];

export function isWorkReturnOutcome(value: unknown): value is WorkReturnOutcome {
  return WORK_RETURN_OUTCOMES.some((outcome) => outcome === value);
}

/** What a specialist's approval card asked and how it stands; only the owner ever decides one. */
export const TASK_APPROVAL_STATUSES = ["pending", "allowed", "always_allowed", "denied"] as const;
export type TaskApprovalStatus = (typeof TASK_APPROVAL_STATUSES)[number];
export type TaskApproval = {
  effectId: string;
  /** The card's own wording of the action. */
  summary: string;
  status: TaskApprovalStatus;
  /** Who settled it; null while it is pending. */
  decidedBy: "user" | null;
};

/**
 * One scoped task as its coordinator sees it, with the tasks its specialist delegated in turn.
 * The single shape of both `inspect` and a coordinator thread's task tree.
 */
export type TaskTreeNode = {
  workId: ScopedWorkId;
  coordinator: { botId: string; threadId: string };
  /** The specialist and its own thread, which the owner may open read-only. */
  executor: { botId: string; threadId: string; name: string };
  /** The specialist's harness; `default` is Rakazo's own. */
  harness: HarnessChoice;
  /** The Computer a native harness runs in; null on Rakazo's own harness. */
  executionTarget: string | null;
  /** How that harness was chosen; null on a task created before the choice was recorded. */
  harnessSource: SpecialistHarnessSource | null;
  /** Why the deterministic fallback decided, when it did. */
  harnessFallbackCause: SpecialistHarnessFallbackCause | null;
  /** T04:4: the coordinator's Computer at delegation time ("Computer de mission"). */
  missionComputerId: string | null;
  status: string;
  parentScopedTaskId: string | null;
  rootScopedTaskId: string;
  depth: number;
  delegationCeiling: McpAccessCeiling;
  /** The latest delivered return: how it ended and its text, which is null when it had none. */
  result: { runId: string; outcome: WorkReturnOutcome; text: string | null } | null;
  approvals: TaskApproval[];
  children: TaskTreeNode[];
};

export const TaskTreeNodeSchema: z.ZodType<TaskTreeNode> = z.lazy(() =>
  z.object({
    workId: Id,
    coordinator: z.object({ botId: Id, threadId: Id }),
    executor: z.object({ botId: Id, threadId: Id, name: z.string() }),
    harness: HarnessChoiceSchema,
    executionTarget: z.string().nullable(),
    harnessSource: z.enum(SPECIALIST_HARNESS_SOURCES).nullable(),
    harnessFallbackCause: z.enum(SPECIALIST_HARNESS_FALLBACK_CAUSES).nullable(),
    missionComputerId: z.string().nullable(),
    status: z.string(),
    parentScopedTaskId: z.string().nullable(),
    rootScopedTaskId: z.string(),
    depth: z.number().int(),
    delegationCeiling: z.record(
      z.string(),
      z.object({ allowAllTools: z.boolean(), allowedTools: z.array(z.string()) }),
    ),
    result: z
      .object({
        runId: Id,
        outcome: z.enum(WORK_RETURN_OUTCOMES),
        text: z.string().nullable(),
      })
      .nullable(),
    approvals: z.array(
      z.object({
        effectId: Id,
        summary: z.string(),
        status: z.enum(TASK_APPROVAL_STATUSES),
        decidedBy: z.literal("user").nullable(),
      }),
    ),
    children: z.array(TaskTreeNodeSchema),
  }),
);

/** The task `inspect` was asked about, with everything it delegated; `nodes` lists them all, root first. */
export type TaskTreePage = { root: TaskTreeNode; nodes: TaskTreeNode[] };

export interface DelegatedTasks {
  apply(command: DelegationCommand, context: CommandContext): Promise<Receipt>;
  inspect(workId: ScopedWorkId, actor: AuthorizedActor, cursor?: string): Promise<TaskTreePage>;
}
