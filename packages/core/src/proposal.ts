import type { AskOutcome, MessageBlock, ProposalKind, RunTrigger } from "@rakazo/contracts";
import { ASK_DISMISSED_ANSWER } from "@rakazo/contracts";
import { botNameKey, hasHiddenText, LINK_LIKE_NAME } from "./spawn-bot.js";

/**
 * A card a bot shows on its own initiative, one row per effect kind: the tool its approval
 * replays as, the card it shows, and what the model is told when the user says no.
 */
type ProposalEffect = {
  tool: string;
  proposal: ProposalKind;
  title: string;
  allowLabel: string;
  declined: string;
  declinedBefore: string;
};

export const PROPOSAL_EFFECTS = {
  routine_proposal: {
    tool: "schedule_create",
    proposal: "routine",
    title: "Create routine?",
    allowLabel: "Create routine",
    declined: "The user declined this routine. Do not propose it again within a day.",
    declinedBefore:
      "The user said Not now to this routine in the last day. Do not propose it again today unless they ask.",
  },
} as const satisfies Record<string, ProposalEffect>;

export type ProposalEffectKind = keyof typeof PROPOSAL_EFFECTS;
export const PROPOSAL_EFFECT_KINDS = Object.keys(PROPOSAL_EFFECTS) as ProposalEffectKind[];

export function proposalEffect(kind: string): ProposalEffect | undefined {
  return Object.hasOwn(PROPOSAL_EFFECTS, kind)
    ? PROPOSAL_EFFECTS[kind as ProposalEffectKind]
    : undefined;
}

/** Cards that make a conversation wait on the user: a proposal is not added next to one. */
export const PENDING_CARD_EFFECT_KINDS: readonly string[] = [
  ...PROPOSAL_EFFECT_KINDS,
  "spawn_bot",
  "create_space",
];

/** The call a resumed model makes to replay an approved effect, with only that tool's arguments. */
export function approvedReplayCall(
  kind: string,
  request: unknown,
): { tool: string; args: unknown } {
  const proposal = proposalEffect(kind);
  return proposal
    ? { tool: proposal.tool, args: withoutProposalKey(request) }
    : { tool: kind, args: request };
}

type RunStarter = "user" | "source_message" | "nobody";

/**
 * Who started a run, by what woke it. A reaction and a taught skill are the user's own taps. A
 * follow_up answers a message: the user's own, or a bot's handoff in a group, so the stored source
 * message decides. A messaging contact is not the user. Nothing writes `resume`; an approval
 * resumes the same run under its own trigger.
 */
const RUN_STARTERS: Record<RunTrigger, RunStarter> = {
  user: "user",
  reaction: "user",
  skill: "user",
  follow_up: "source_message",
  messaging: "nobody",
  spawn: "nobody",
  routine: "nobody",
  resume: "nobody",
  bot_message: "nobody",
  webhook: "nobody",
};

/** A stored trigger outside the union, written before it existed, counts as nobody's. */
export function runStartedByUser(run: { trigger: string; sourceRole?: string | null }): boolean {
  const starter = Object.hasOwn(RUN_STARTERS, run.trigger)
    ? RUN_STARTERS[run.trigger as RunTrigger]
    : "nobody";
  return starter === "user" || (starter === "source_message" && run.sourceRole === "user");
}

export const PROPOSE_IN_DIRECT_ERROR =
  "Propose a routine only in your direct conversation with the user, while they are in it.";

/** A bot proposes new routines only; a change it would propose has no card yet. */
export const PROPOSE_CHANGE_ERROR = "Proposing a change to a routine is not available yet.";

export function proposalPlaceError(
  run: { trigger: string; sourceRole?: string | null },
  inGroup: boolean,
): string | undefined {
  return inGroup || !runStartedByUser(run) ? PROPOSE_IN_DIRECT_ERROR : undefined;
}

/** A card shows what will be created in full, so what it may hold is bounded. */
export const CARD_ROUTINE_NAME_MAX_LENGTH = 80;
export const CARD_ROUTINE_PROMPT_MAX_LENGTH = 2000;

/** The tool error for a proposed routine too large to show on a card, checked before the card. */
export function routineCardSizeError(args: Record<string, unknown>): string | undefined {
  const text = (key: string) => {
    const value = args[key];
    return typeof value === "string" ? value.trim() : "";
  };
  if (text("name").length > CARD_ROUTINE_NAME_MAX_LENGTH) {
    return `name must be at most ${CARD_ROUTINE_NAME_MAX_LENGTH} characters.`;
  }
  if (text("prompt").length > CARD_ROUTINE_PROMPT_MAX_LENGTH) {
    return `prompt must be at most ${CARD_ROUTINE_PROMPT_MAX_LENGTH} characters for the user to confirm it.`;
  }
  return undefined;
}

/** Cards a reply typed in the composer puts away instead of being refused. */
export const DISMISSABLE_EFFECT_KINDS: ReadonlySet<string> = new Set(PROPOSAL_EFFECT_KINDS);

/** The marker a card put away by typing leaves on its effect, so no guard counts it as a no. */
export const DISMISSED_EFFECT_RESULT = { outcome: ASK_DISMISSED_ANSWER } as const;

export function isDismissedEffectResult(result: unknown): boolean {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    (result as { outcome?: unknown }).outcome === ASK_DISMISSED_ANSWER
  );
}

/** How a settled card ended: the outcome of the tapped action, or put away by typing. */
export function askOutcome(block: {
  answer?: string;
  actions?: ReadonlyArray<{ id: string; outcome?: AskOutcome }>;
}): AskOutcome | undefined {
  if (block.answer === ASK_DISMISSED_ANSWER) return "dismissed";
  return block.actions?.find((action) => action.id === block.answer)?.outcome;
}

/**
 * How an answered routine card reads: what came of it, or "creating" between the tap and the run
 * settling it (the run always settles an approved card, created or failed).
 */
export function routineCardSettlement(block: {
  answer?: string;
  actions?: ReadonlyArray<{ id: string; outcome?: AskOutcome }>;
  created?: unknown;
  failed?: true;
}): "created" | "failed" | "not_now" | "creating" | "answered" {
  if (block.created) return "created";
  if (block.failed) return "failed";
  const outcome = askOutcome(block);
  if (outcome === "cancelled" || outcome === "dismissed") return "not_now";
  return outcome === "created" ? "creating" : "answered";
}

/** What the model is told for a card the user answered by typing instead. */
export const DISMISSED_PROPOSAL_RESULT = {
  ok: false,
  dismissed: true,
  note: "The user replied instead of answering. If they asked for a change, propose the corrected version now, however many times they ask; if the reply was about something else, do not propose again.",
} as const;

/** The non-error result a resumed call gets for a refused or put-away proposal card. */
export function refusedProposalResult(kind: string, effectResult: unknown): unknown | undefined {
  const proposal = proposalEffect(kind);
  if (!proposal) return undefined;
  if (isDismissedEffectResult(effectResult)) return { ...DISMISSED_PROPOSAL_RESULT };
  return { ok: false, declined: true, note: proposal.declined };
}

/** `proposed` is a strict boolean: anything else is refused, and false never removes a card. */
export function parseProposed(args: Record<string, unknown>): boolean | { error: string } {
  const { proposed } = args;
  if (proposed !== undefined && typeof proposed !== "boolean") {
    return { error: "proposed must be true or false." };
  }
  return proposed === true;
}

export const CARD_QUESTION_MAX_LENGTH = 120;

/**
 * The question a bot writes as a card's title: one short visible line, never a link. The buttons
 * keep their fixed labels, so a misleading question cannot change what they do.
 */
export function cardQuestionError(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return "question must be a string.";
  const question = value.trim();
  if (!question || question.length > CARD_QUESTION_MAX_LENGTH) {
    return `question must be 1 to ${CARD_QUESTION_MAX_LENGTH} characters.`;
  }
  if (hasHiddenText(question)) {
    return "question must be a single line of visible text, without invisible or control characters.";
  }
  if (LINK_LIKE_NAME.test(question)) {
    return "question cannot contain [, ], <, > or a web address (://, www.).";
  }
  return undefined;
}

/** The bot's own title for a card, checked only when a card will show. */
export function parseCardQuestion(value: unknown): { question?: string } | { error: string } {
  const error = cardQuestionError(value);
  if (error) return { error };
  return typeof value === "string" ? { question: value.trim() } : {};
}

const PROPOSAL_KEY_MAX_LENGTH = 40;

/**
 * The name a proposal is remembered by: what "the same proposal" means, whatever its case,
 * width, spacing or markup.
 */
export function proposalKey(name: string): string {
  return botNameKey(name)
    .replace(/[^\p{L}\p{N} '_.-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PROPOSAL_KEY_MAX_LENGTH)
    .trim();
}

/**
 * A proposal's stored request carries its key, so a refusal of the same proposal is found by an
 * indexed lookup; the replayed call never sees it.
 */
export const PROPOSAL_KEY_FIELD = "proposalKey";

export function withProposalKey(
  request: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return { ...request, [PROPOSAL_KEY_FIELD]: proposalKey(name) };
}

export function withoutProposalKey(request: unknown): unknown {
  if (!request || typeof request !== "object" || Array.isArray(request)) return request;
  const { [PROPOSAL_KEY_FIELD]: _key, ...rest } = request as Record<string, unknown>;
  return rest;
}

/** A proposal card this bot recorded, as the guards read it from the stored effects. */
export type ProposalRecord = {
  kind: string;
  runId: string;
  name: string;
  threadId: string;
  status: string;
  dismissed: boolean;
  /** The user saw the card: it waits, or it was answered. */
  shown: boolean;
  createdAt: Date;
  answeredAt?: Date | null;
};

export type ProposalGuardInput = {
  kind: ProposalEffectKind;
  name: string;
  runId: string;
  threadId: string;
  now: Date;
  /** Another card already waits on the user in this conversation. */
  pendingCard: boolean;
  /**
   * This bot's proposal cards: a Not now in this run, a Not now to this one in the last day, the
   * last day's, and the latest of this conversation, whatever its age.
   */
  records: readonly ProposalRecord[];
};

/** What the model gets instead of a card: an error, or a non-error result to stop on. */
export type ProposalRefusal = { error: string } | { result: unknown };

export const PROPOSAL_PENDING_ERROR =
  "Another card is already waiting for the user's answer in this conversation. Do not propose anything until they answer.";
export const PROPOSAL_REPEAT_ERROR =
  "You already proposed this in the last day. Do not propose it again today.";
export const PROPOSAL_DAILY_ERROR =
  "You already proposed five things to the user in the last day. Do not propose again today.";
export const PROPOSAL_RUN_ERROR =
  "You already proposed two things to the user in this run. Do not propose again.";
/**
 * How long a shown proposal counts against the caps and keeps its topic from being proposed again,
 * and a Not now holds its proposal back.
 */
export const PROPOSAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const PROPOSALS_PER_DAY = 5;
const PROPOSALS_PER_RUN = 2;

const said = (record: ProposalRecord) => record.status === "denied" && !record.dismissed;

/**
 * A card shown right after one of its kind in its thread was put away by typing. Typing over a
 * card resumes the run that showed it, so a correction always comes from that same run.
 */
const corrects = (previous: ProposalRecord | undefined, next: { kind: string; runId: string }) =>
  previous?.kind === next.kind && previous.runId === next.runId && previous.dismissed;

/**
 * What the guards weigh: whether the card asked for is a correction, the cards shown in the last
 * day, and the chains among them.
 * A chain starts with a first proposal, its head, and continues for as long as the user answers
 * by typing and the bot proposes again in that run, with no other card between. Only heads count
 * against the caps, so a user can correct as often as they like.
 */
type ProposalSituation = {
  input: ProposalGuardInput;
  correction: boolean;
  shown: readonly ProposalRecord[];
  heads: readonly ProposalRecord[];
};

function situationOf(input: ProposalGuardInput): ProposalSituation {
  const inWindow = (r: ProposalRecord) =>
    input.now.getTime() - r.createdAt.getTime() < PROPOSAL_WINDOW_MS;
  const thread = new Map<string, ProposalRecord>();
  const heads: ProposalRecord[] = [];
  const cards = input.records
    .filter((r) => r.shown)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const card of cards) {
    if (!corrects(thread.get(card.threadId), card)) heads.push(card);
    thread.set(card.threadId, card);
  }
  return {
    input,
    correction: corrects(thread.get(input.threadId), input),
    shown: cards.filter(inWindow),
    heads: heads.filter(inWindow),
  };
}

/**
 * Checked in order before a proposal card shows; the first that answers wins. A card put away by
 * typing is no refusal, and the card that follows it is a correction: it skips the guards that
 * ration first proposals.
 */
const PROPOSAL_GUARDS: ReadonlyArray<{
  appliesToCorrections: boolean;
  check: (situation: ProposalSituation) => ProposalRefusal | undefined;
}> = [
  {
    appliesToCorrections: true,
    check: ({ input }) => (input.pendingCard ? { error: PROPOSAL_PENDING_ERROR } : undefined),
  },
  {
    appliesToCorrections: true,
    check: ({ input }) =>
      input.records.some((r) => r.kind === input.kind && r.runId === input.runId && said(r))
        ? { result: refusedProposalResult(input.kind, undefined) }
        : undefined,
  },
  {
    appliesToCorrections: true,
    check: ({ input }) => {
      const key = proposalKey(input.name);
      return input.records.some(
        (r) =>
          r.kind === input.kind &&
          said(r) &&
          proposalKey(r.name) === key &&
          input.now.getTime() - (r.answeredAt ?? r.createdAt).getTime() < PROPOSAL_WINDOW_MS,
      )
        ? { error: PROPOSAL_EFFECTS[input.kind].declinedBefore }
        : undefined;
    },
  },
  {
    appliesToCorrections: false,
    check: ({ input, shown }) => {
      const key = proposalKey(input.name);
      return shown.some((r) => r.kind === input.kind && proposalKey(r.name) === key)
        ? { error: PROPOSAL_REPEAT_ERROR }
        : undefined;
    },
  },
  {
    appliesToCorrections: false,
    check: ({ heads }) =>
      heads.length >= PROPOSALS_PER_DAY ? { error: PROPOSAL_DAILY_ERROR } : undefined,
  },
  {
    appliesToCorrections: false,
    check: ({ input, heads }) =>
      heads.filter((r) => r.runId === input.runId).length >= PROPOSALS_PER_RUN
        ? { error: PROPOSAL_RUN_ERROR }
        : undefined,
  },
];

export function proposalRefusal(input: ProposalGuardInput): ProposalRefusal | undefined {
  const situation = situationOf(input);
  for (const guard of PROPOSAL_GUARDS) {
    if (situation.correction && !guard.appliesToCorrections) continue;
    const refusal = guard.check(situation);
    if (refusal) return refusal;
  }
  return undefined;
}

export type RoutinePreview = { name: string; schedule: string; prompt: string; notify: boolean };

/** What a routine card shows is read as plain text: nothing hidden, no name passing for a link. */
export function routineCardTextError(name: string, prompt: string): string | undefined {
  if (hasHiddenText(name)) {
    return "name must be a single line of visible text, without invisible or control characters.";
  }
  if (LINK_LIKE_NAME.test(name))
    return "name cannot contain [, ], <, > or a web address (://, www.).";
  if (hasHiddenText(prompt, true)) {
    return "prompt must not contain invisible or control characters.";
  }
  return undefined;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export type RoutineCard = { routine: RoutinePreview; question?: string };

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/**
 * A routine card: `detail` repeats the preview as plain text for a client that does not know
 * `routine`.
 */
function routineAsk(effectId: string, routine: RoutinePreview, text: string): AskBlock {
  const proposal = PROPOSAL_EFFECTS.routine_proposal;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text,
    detail: [
      `name: ${routine.name}`,
      `schedule: ${routine.schedule}`,
      `notify: ${routine.notify ? "yes" : "no"}`,
      "prompt:",
      indent(routine.prompt),
    ].join("\n"),
    status: "pending",
    actions: [
      { id: "allow", label: proposal.allowLabel, outcome: "created" },
      { id: "deny", label: "Not now", outcome: "cancelled" },
    ],
    routine,
  };
}

/** The card a bot proposes a routine with; only it is put away by a typed reply. */
export function routineCardBlock(effectId: string, { routine, question }: RoutineCard): AskBlock {
  const proposal = PROPOSAL_EFFECTS.routine_proposal;
  return {
    ...routineAsk(effectId, routine, question || proposal.title),
    proposal: proposal.proposal,
  };
}

export type CreatedRoutine = RoutinePreview & { id: string };

/** A routine card once its routine exists: it opens on when the routine runs and links to it. */
function settledOn({
  id,
  ...preview
}: CreatedRoutine): Pick<AskBlock, "text" | "routine" | "created"> {
  return {
    text: preview.schedule,
    routine: preview,
    created: { kind: "routine", id, label: preview.name },
  };
}

/** A routine the user asked for, set up or changed: its card already settled, with nothing to answer. */
export function routineConfirmationBlock(
  effectId: string,
  routine: CreatedRoutine,
  change: "created" | "updated",
): AskBlock {
  return {
    ...routineAsk(effectId, routine, routine.schedule),
    status: "answered",
    ...settledOn(routine),
    confirms: change,
  };
}

/** The approval card the user allowed for a routine, settled on the routine it set up or changed. */
export function settleRoutineAsk(
  card: AskBlock,
  routine: CreatedRoutine,
  change: "created" | "updated",
): AskBlock {
  return { ...card, ...settledOn(routine), confirms: change };
}
