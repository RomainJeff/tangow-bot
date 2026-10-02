import type {
  HarnessChoice,
  SpecialistHarnessFallbackCause,
  SpecialistHarnessSource,
} from "./harness-choice.js";

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
  | { kind: "close"; workId: ScopedWorkId };

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

export type TaskTreeNode = {
  workId: ScopedWorkId;
  coordinator: { botId: string; threadId: string };
  executor: { botId: string; threadId: string };
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
  /** The durable delivery projection; the text itself remains in the coordinator thread. */
  result: { runId: string; outcome: string } | null;
};

export type TaskTreePage = { root: TaskTreeNode; nodes: TaskTreeNode[] };

export interface DelegatedTasks {
  apply(command: DelegationCommand, context: CommandContext): Promise<Receipt>;
  inspect(workId: ScopedWorkId, actor: AuthorizedActor, cursor?: string): Promise<TaskTreePage>;
}
