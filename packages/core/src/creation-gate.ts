import { runStartedByUser, runStarter } from "./run-exposure.js";

/**
 * What a bot may create that keeps acting or shapes later runs (a routine, a skill), decided by
 * the server from the run, never by the model. One row per tool, one column per run stance.
 */
export type CreationTool = "schedule_create" | "skill_create" | "skill_update" | "skill_delete";

/**
 * Where the run stands: started by the user and clean, started by the user but exposed to
 * outside content, started by an external messaging contact, or started by anything else
 * (routine, webhook, another bot) with nobody watching.
 */
export type RunStance = "clean" | "exposed" | "messaging" | "unattended";

export type CreationGate =
  | { kind: "direct" }
  /** Mandatory approval: no user rule, auto-review or exemption applies, and no "always". */
  | {
      kind: "card";
      effectKind: string;
      /** A refusal keeps the bot from asking again for a day in runs nobody is watching. */
      lockAfterRefusal: boolean;
    }
  | { kind: "refuse"; error: string };

export const ROUTINES_FROM_APP_ERROR = "Routines can only be created from the app.";
export const SKILLS_WITH_USER_ERROR =
  "Skills are only saved while the user is in the conversation.";
export const SKILL_DELETE_ERROR = "Ask the user to delete this skill from their skills.";

/** The effect a skill card records: one kind for a new skill and a changed one. */
export const SKILL_SAVE_EFFECT = "skill_save";

const DIRECT: CreationGate = { kind: "direct" };
const skillCard: CreationGate = {
  kind: "card",
  effectKind: SKILL_SAVE_EFFECT,
  lockAfterRefusal: false,
};
const skillRefusal: CreationGate = { kind: "refuse", error: SKILLS_WITH_USER_ERROR };
const deleteRefusal: CreationGate = { kind: "refuse", error: SKILL_DELETE_ERROR };

const CREATION_GATES: Record<CreationTool, Record<RunStance, CreationGate>> = {
  schedule_create: {
    clean: DIRECT,
    exposed: { kind: "card", effectKind: "schedule_create", lockAfterRefusal: false },
    messaging: { kind: "refuse", error: ROUTINES_FROM_APP_ERROR },
    unattended: { kind: "card", effectKind: "schedule_create", lockAfterRefusal: true },
  },
  skill_create: {
    clean: DIRECT,
    exposed: skillCard,
    messaging: skillRefusal,
    unattended: skillRefusal,
  },
  skill_update: {
    clean: DIRECT,
    exposed: skillCard,
    messaging: skillRefusal,
    unattended: skillRefusal,
  },
  skill_delete: {
    clean: DIRECT,
    exposed: deleteRefusal,
    messaging: deleteRefusal,
    unattended: deleteRefusal,
  },
};

export function runStance(run: {
  trigger: string;
  sourceRole?: string | null;
  exposed: boolean;
}): RunStance {
  if (runStarter(run.trigger) === "messaging") return "messaging";
  if (!runStartedByUser(run)) return "unattended";
  return run.exposed ? "exposed" : "clean";
}

/** The gate for a built-in tool, or undefined when the tool creates nothing gated. */
export function creationGate(toolName: string, stance: RunStance): CreationGate | undefined {
  return Object.hasOwn(CREATION_GATES, toolName)
    ? CREATION_GATES[toolName as CreationTool][stance]
    : undefined;
}

/**
 * Whether the user refusing this tool's card in that run keeps the bot from asking again. A card
 * only shows in a run that was exposed or that nobody started, so the run is judged exposed.
 */
export function refusalLocks(
  toolName: string,
  run: { trigger: string; sourceRole?: string | null },
): boolean {
  const gate = creationGate(toolName, runStance({ ...run, exposed: true }));
  return gate?.kind === "card" && gate.lockAfterRefusal;
}

/** A card shows what will be created in full, so what it may hold is bounded. */
export const CARD_ROUTINE_NAME_MAX_LENGTH = 80;
export const CARD_ROUTINE_PROMPT_MAX_LENGTH = 2000;
export const CARD_SKILL_MAX_LENGTH = 8000;

/** The tool error for a request too large to show on a card, checked before the card. */
export function creationCardError(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  const text = (key: string) => {
    const value = args[key];
    return typeof value === "string" ? value : "";
  };
  if (toolName === "schedule_create") {
    if (text("name").trim().length > CARD_ROUTINE_NAME_MAX_LENGTH) {
      return `name must be at most ${CARD_ROUTINE_NAME_MAX_LENGTH} characters.`;
    }
    if (text("prompt").trim().length > CARD_ROUTINE_PROMPT_MAX_LENGTH) {
      return `prompt must be at most ${CARD_ROUTINE_PROMPT_MAX_LENGTH} characters for the user to confirm it.`;
    }
  }
  if (text("content").length > CARD_SKILL_MAX_LENGTH) {
    return `This skill must be at most ${CARD_SKILL_MAX_LENGTH} characters for the user to confirm it.`;
  }
  return undefined;
}

export type SkillSaveRequest = {
  change: "created" | "updated";
  /** The skill to change; for a new skill, its name. */
  name: string;
  /** The whole SKILL.md that will be written, exactly as the card shows it. */
  content: string;
};

/** A stored skill card request, parsed: it comes back from the database on replay. */
export function asSkillSaveRequest(value: unknown): SkillSaveRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { change, name, content } = value as Record<string, unknown>;
  if (change !== "created" && change !== "updated") return undefined;
  if (typeof name !== "string" || typeof content !== "string") return undefined;
  return { change, name, content };
}

/**
 * The call a resumed model makes to replay an approved effect. A skill card stores what will be
 * written, so it replays as the tool that writes that change, with only that tool's arguments.
 */
export function approvedReplayCall(
  kind: string,
  request: unknown,
): { tool: string; args: unknown } {
  const save = kind === SKILL_SAVE_EFFECT ? asSkillSaveRequest(request) : undefined;
  if (!save) return { tool: kind, args: request };
  return save.change === "updated"
    ? { tool: "skill_update", args: { name: save.name, content: save.content } }
    : { tool: "skill_create", args: { content: save.content } };
}
