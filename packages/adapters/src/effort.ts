import type {
  AdapterContext,
  AgentHistoryMessage,
  AgentThinkingLevel,
  DecisionProvider,
  DecisionRequest,
  DecisionResult,
  DecisionUnavailableReason,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import { decideWithin } from "./decision.js";

/** A starting budget, to be tuned from the measured `agent.decision.call` durations for "effort". */
const EFFORT_DECISION_TIMEOUT_MS = 500;

const MESSAGE_CHAR_BUDGET = 1_200;
const TURN_CHAR_BUDGET = 300;
/** Prior turns the classifier reads: about the last two exchanges. */
export const EFFORT_HISTORY_TURNS = 4;

/**
 * What the classifier reads for each level Auto may pick, lowest first. `off` is left out to
 * avoid a quality drop on reasoning models, `max` because it is never worth its cost by default.
 */
const AUTO_LEVELS = {
  minimal: "Trivial: a greeting, thanks, an acknowledgement, or a one-line reply.",
  low: "Simple: a short answer or one straightforward action.",
  medium: "Normal: a typical request that needs some thought or a few steps.",
  high: "Hard: multi-step reasoning, analysis, debugging, planning, or careful writing.",
  xhigh: "Very hard: a long, intricate problem that needs deep, sustained reasoning.",
} satisfies Partial<Record<AgentThinkingLevel, string>>;

type AutoLevel = keyof typeof AUTO_LEVELS;

const EFFORT_INSTRUCTIONS =
  "How much reasoning does the assistant need to answer the latest message well? Pick the lowest level that still answers it well.";

/** Where a run's thinking level came from, so the logs say why a run thought as hard as it did. */
export type EffortChoice =
  | { source: "manual"; level: AgentThinkingLevel }
  | { source: "auto"; level: AgentThinkingLevel; probability: number }
  | {
      source: "fallback";
      level: AgentThinkingLevel | null;
      reason: DecisionUnavailableReason | "no_choice";
    };

export interface EffortInput {
  /** The level picked by hand on the bot; it always wins. */
  manual: AgentThinkingLevel | null;
  /** What the run uses when nothing is decided: the connection's own level, if any. */
  fallback: AgentThinkingLevel | null;
  /** Levels the runtime accepts for this model. */
  supported: readonly AgentThinkingLevel[];
  /** The latest message, already redacted. */
  message: string;
  /** Up to `EFFORT_HISTORY_TURNS` turns before the message, oldest first, already redacted. */
  history: readonly Pick<AgentHistoryMessage, "role" | "content">[];
}

/** The levels Auto chooses between, in ascending order. */
function autoEffortLevels(supported: readonly AgentThinkingLevel[]): AutoLevel[] {
  return (Object.keys(AUTO_LEVELS) as AutoLevel[]).filter((level) => supported.includes(level));
}

/** Reads a decision over `levels` into the run's level; any unavailable decision falls back. */
function effortFromDecision(
  levels: readonly AutoLevel[],
  decision: DecisionResult,
  fallback: AgentThinkingLevel | null,
): EffortChoice {
  if (!decision.ok) return { source: "fallback", level: fallback, reason: decision.reason };
  const answer = decision.answers.effort;
  if (answer?.type !== "score") {
    return { source: "fallback", level: fallback, reason: "invalid_answer" };
  }
  // Ties go to the higher level: under-thinking a hard message costs more than the reverse.
  let best = { index: -1, probability: -1 };
  for (const [key, probability] of Object.entries(answer.probabilities)) {
    const index = Number(key);
    if (
      probability > best.probability ||
      (probability === best.probability && index > best.index)
    ) {
      best = { index, probability };
    }
  }
  const level = levels[best.index];
  if (!level) return { source: "fallback", level: fallback, reason: "invalid_answer" };
  return { source: "auto", level, probability: best.probability };
}

function effortDecisionRequest(
  levels: readonly AutoLevel[],
  message: string,
  history: EffortInput["history"],
): DecisionRequest {
  return {
    state: {
      message: clip(message, MESSAGE_CHAR_BUDGET),
      earlier: history.map((turn) => ({
        role: turn.role,
        text: clip(turn.content, TURN_CHAR_BUDGET),
      })),
    },
    questions: {
      effort: {
        type: "score",
        instructions: EFFORT_INSTRUCTIONS,
        levels: levels.map((level) => AUTO_LEVELS[level]),
      },
    },
  };
}

/**
 * The run's thinking level. A hand-picked level wins; otherwise the decision provider picks
 * one per run, and without a usable answer the run keeps today's behaviour. Never throws.
 */
export async function resolveEffort(
  provider: DecisionProvider | null,
  input: EffortInput,
  context: AdapterContext,
): Promise<EffortChoice> {
  if (input.manual) return log(context, { source: "manual", level: input.manual });
  const levels = autoEffortLevels(input.supported);
  if (levels.length < 2) {
    return log(context, { source: "fallback", level: input.fallback, reason: "no_choice" });
  }
  if (!provider) {
    return log(context, { source: "fallback", level: input.fallback, reason: "no_provider" });
  }
  const started = Date.now();
  const decision = await decideWithin(
    provider,
    effortDecisionRequest(levels, input.message, input.history),
    context,
    { timeoutMs: EFFORT_DECISION_TIMEOUT_MS, purpose: "effort" },
  );
  return log(context, effortFromDecision(levels, decision, input.fallback), Date.now() - started);
}

function log(context: AdapterContext, choice: EffortChoice, decisionMs?: number): EffortChoice {
  getLogger().info("agent.run.effort", {
    runId: context.runId,
    botId: context.botId,
    spaceId: context.spaceId,
    source: choice.source,
    thinkingLevel: choice.level,
    probability: choice.source === "auto" ? Number(choice.probability.toFixed(3)) : undefined,
    reason: choice.source === "fallback" ? choice.reason : undefined,
    decisionMs,
  });
  return choice;
}

function clip(text: string, budget: number): string {
  return text.length <= budget ? text : `${text.slice(0, budget)}…`;
}
