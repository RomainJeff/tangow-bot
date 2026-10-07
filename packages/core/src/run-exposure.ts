import type { MessageBlock, RunTrigger } from "@rakazo/contracts";

/**
 * Why a run may have read content nobody in the conversation wrote. A run that is exposed stays
 * exposed: the marker is stored on the run and never cleared.
 */
export const EXPOSURE_REASONS = [
  "trigger",
  "attachment",
  "skill",
  "history",
  "tool",
  /** A skill saved from a workspace folder holding a file this run did not write. */
  "workspace",
] as const;
export type ExposureReason = (typeof EXPOSURE_REASONS)[number];

/**
 * Built-in tools whose result is the bot's own data, never content from outside. Closed: any
 * other tool, a connector tool or an unknown name exposes the run. `skill_read` depends on the
 * skill it returns (skillExposesRun). write_file and edit_file return no file text, only the
 * path, a replacement count or an error.
 */
const CONTENT_FREE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "remember",
  "recall_memory",
  "save_memory",
  "forget_memory",
  "scratchpad_list",
  "scratchpad_add",
  "scratchpad_update",
  "scratchpad_complete",
  "scratchpad_remove",
  "schedule_list",
  "schedule_create",
  "schedule_cancel",
  "skill_create",
  "skill_update",
  "skill_delete",
  "message_user",
  "ask_user",
]);

/** The tool error when the run could not record that it is about to read outside content. */
export const RUN_STATE_UNSAVED_ERROR =
  "This tool call was not run because the run could not save its state. Try again.";

export function toolExposesRun(name: string, viaConnector: boolean): boolean {
  if (viaConnector) return true;
  return name !== "skill_read" && !CONTENT_FREE_TOOLS.has(name);
}

/** The user's own skills, a bot's private ones included, and the product's built-ins. */
export function skillExposesRun(source: string): boolean {
  return source !== "user" && source !== "builtin";
}

export function blocksCarryAttachment(blocks: readonly MessageBlock[]): boolean {
  return blocks.some((block) => block.kind === "image" || block.kind === "file");
}

/** Blocks the bot or the user wrote themselves. Anything else, a future kind included, exposes. */
const OWN_BLOCK_KINDS = new Set<string>([
  "text",
  "reasoning",
  "link_preview",
  "chart",
  "ask",
  "choice",
  "card",
  "progress",
  "meta",
  "computer",
  "child_bot",
  "connect",
  "app_connect",
  "mcp_approval",
  "skill_draft",
  "routine_run",
  "bot_message_sent",
]);

/** skill_read results lead with the skill's source, so a truncated output still tells it. */
const OWN_SKILL_READ_OUTPUT = /^\{\s*"source":\s*"(?:user|builtin)"/;

type StepsBlock = Extract<MessageBlock, { kind: "steps" }>;

function stepsExpose(block: StepsBlock): boolean {
  return block.steps.some((step) => {
    // Without every call stored, the history replays the steps as text whose tools are unknown.
    if (!step.calls || step.calls.length !== step.count) return true;
    return step.calls.some((call) => {
      if (!call.id) return true;
      if (call.name === "skill_read") return !OWN_SKILL_READ_OUTPUT.test(call.output);
      return toolExposesRun(call.name, false);
    });
  });
}

function blockExposes(block: unknown): boolean {
  if (!block || typeof block !== "object") return true;
  const kind = (block as { kind?: unknown }).kind;
  if (kind === "steps") {
    const steps = (block as { steps?: unknown }).steps;
    return !Array.isArray(steps) || stepsExpose(block as StepsBlock);
  }
  return typeof kind !== "string" || !OWN_BLOCK_KINDS.has(kind);
}

export type ExposureHistoryMessage = {
  role: string;
  botId?: string | null;
  runId?: string | null;
  blocks: unknown;
};

/** A run as stored: what woke it, the role of the message it answers, and its marker. */
export type ExposureRun = {
  id: string;
  trigger: string;
  sourceRole?: string | null;
  exposedAt: Date | null;
};

type RunStarter = "user" | "source_message" | "messaging" | "nobody";

/**
 * Who started a run, by what woke it. A reaction and a taught skill are the user's own taps. A
 * follow_up answers a message: the user's own, or a bot's handoff in a group, so the stored source
 * message decides. Nothing writes `resume`; an approval resumes the same run under its own trigger.
 */
const RUN_STARTERS: Record<RunTrigger, RunStarter> = {
  user: "user",
  reaction: "user",
  skill: "user",
  follow_up: "source_message",
  messaging: "messaging",
  spawn: "nobody",
  routine: "nobody",
  resume: "nobody",
  bot_message: "nobody",
  webhook: "nobody",
};

/** A stored trigger outside the union, written before it existed, counts as nobody's. */
export function runStarter(trigger: string): RunStarter {
  return Object.hasOwn(RUN_STARTERS, trigger) ? RUN_STARTERS[trigger as RunTrigger] : "nobody";
}

export function runStartedByUser(run: { trigger: string; sourceRole?: string | null }): boolean {
  const starter = runStarter(run.trigger);
  return starter === "user" || (starter === "source_message" && run.sourceRole === "user");
}

/**
 * Whether the messages replayed or quoted to the model carry outside content: a tool output from
 * outside the closed list, steps whose calls were not all kept, another bot's words, an
 * attachment, or this bot's words from a run that was exposed or that the user did not start.
 * `runs` holds the stored runs of those messages; a bot message whose run is missing exposes.
 * A compaction summary is not a message here: what survives only in it is accepted like memory.
 */
export function historyExposes(
  messages: readonly ExposureHistoryMessage[],
  selfBotId: string,
  runs: readonly ExposureRun[],
): boolean {
  const cleanRunIds = new Set(
    runs.filter((run) => run.exposedAt == null && runStartedByUser(run)).map((run) => run.id),
  );
  return messages.some((message) => {
    if (message.role === "bot") {
      if (message.botId && message.botId !== selfBotId) return true;
      if (message.runId && !cleanRunIds.has(message.runId)) return true;
    }
    return !Array.isArray(message.blocks) || message.blocks.some(blockExposes);
  });
}
