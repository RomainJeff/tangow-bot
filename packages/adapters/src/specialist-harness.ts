import type { AdapterContext, DecisionProvider, ToolCallTrace } from "@rakazo/adapter-kit";
import type {
  HarnessChoice,
  NativeHarnessChoice,
  SpecialistHarnessFallbackCause,
  SpecialistHarnessSource,
} from "@rakazo/contracts";
import {
  HARNESS_MODEL_NAMES,
  harnessModelName,
  isNativeHarness,
  NATIVE_HARNESSES,
} from "@rakazo/contracts";
import { decideWithin } from "./decision.js";
import { availableHarnesses, nativeHarnessRefusal } from "./native-harness-availability.js";

/** A requested harness the specialist cannot run; worded for the coordinator model. */
export class SpecialistHarnessUnavailableError extends Error {}

/** A harness the coordinator named that is not one of the model-facing names. */
export class UnknownSpecialistHarnessError extends Error {}

export interface SpecialistHarnessChoice {
  harness: HarnessChoice;
  source: SpecialistHarnessSource;
  /** Why the deterministic fallback decided, when it did. */
  fallbackCause?: SpecialistHarnessFallbackCause;
}

/**
 * The harness a coordinator named in its own words (`rakazo`, `codex`, `claude`) as the stored
 * choice. Anything else is refused outright rather than ignored, since silently picking another
 * harness would hide that the request was not understood.
 */
export function requestedSpecialistHarness(value: unknown): HarnessChoice | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && Object.hasOwn(HARNESS_MODEL_NAMES, value))
    return HARNESS_MODEL_NAMES[value as keyof typeof HARNESS_MODEL_NAMES];
  throw new UnknownSpecialistHarnessError(
    `Unknown harness ${JSON.stringify(value)}. Use one of ${Object.keys(HARNESS_MODEL_NAMES).join(", ")}, or leave it out.`,
  );
}

/** What each harness is, stated as fact; the same text is what a judgment weighs. */
const HARNESS_DESCRIPTIONS: Record<HarnessChoice, string> = {
  default:
    "Rakazo's own agent loop. It works through Rakazo's tools and connectors and runs on the specialist's configured model.",
  "codex-native":
    "The Codex command-line agent, running inside the mission's Computer. It reads, edits and runs code and shell commands in that Computer's files, on a ChatGPT subscription model.",
  "claude-native":
    "The Claude Code command-line agent, running inside the mission's Computer. It reads, edits and runs code and shell commands in that Computer's files, on a Claude subscription model.",
};

const JUDGMENT_TIMEOUT_MS = 10_000;
/** What leaves the process for a judgment is capped, whoever wrote it. */
const BRIEF_STATE_MAX = 4_000;
const PROFILE_NAME_STATE_MAX = 200;
const PROFILE_DESCRIPTION_STATE_MAX = 1_000;

export interface SpecialistHarnessInput {
  /** The coordinator's explicit request; `default` asks for Rakazo's own harness. */
  explicit?: HarnessChoice;
  /** The profile's harness when it was ever set, Rakazo's own included; null when never set. */
  profileChoice: HarnessChoice | null;
  /** Native harness serving the coordinator's own Run; null when it runs on Rakazo. */
  coordinatorHarness: NativeHarnessChoice | null;
  /** The Computer of mission, or none. */
  missionComputerId: string | null;
  /** The provider of the model the specialist will run on; read only when a harness needs it. */
  modelProvider: () => Promise<string | null>;
  brief: string;
  profile: { name?: string | null; description?: string | null };
  /** Removes run secrets from text before it leaves the process. */
  redact: (text: string) => string;
  judgment?: {
    provider: DecisionProvider | undefined;
    context: AdapterContext;
    trace?: ToolCallTrace;
  };
}

/**
 * Picks the harness a specialist runs on. The coordinator's explicit request, then the
 * profile's choice when it was ever set, always win and are refused when the harness cannot
 * run. Otherwise, when several harnesses are available and a decision provider is configured,
 * one judgment picks among those harnesses only. A missing provider, a failed judgment or a
 * single candidate falls back to the coordinator's own harness when it is available, else
 * Rakazo's.
 */
export async function chooseSpecialistHarness(
  input: SpecialistHarnessInput,
): Promise<SpecialistHarnessChoice> {
  const available = async () =>
    availableHarnesses(input.missionComputerId, await input.modelProvider());
  const requested = async (
    harness: HarnessChoice,
    source: "explicit" | "profile",
  ): Promise<SpecialistHarnessChoice> => {
    if (isNativeHarness(harness)) {
      const refusal = nativeHarnessRefusal(
        harness,
        input.missionComputerId,
        await input.modelProvider(),
      );
      if (refusal) {
        const { name } = NATIVE_HARNESSES[harness];
        throw new SpecialistHarnessUnavailableError(
          refusal === "computer"
            ? `${name} is not available for this specialist: the mission has no Computer to run it in. Ask for the rakazo harness or leave the harness unset.`
            : `${name} is not available for this specialist: its model is not on a connected ${name} subscription. Ask for the rakazo harness or leave the harness unset.`,
        );
      }
    }
    return { harness, source };
  };
  if (input.explicit !== undefined) return requested(input.explicit, "explicit");
  if (input.profileChoice !== null) return requested(input.profileChoice, "profile");

  const provider = input.judgment?.provider;
  const fallback = async (
    fallbackCause: SpecialistHarnessFallbackCause,
  ): Promise<SpecialistHarnessChoice> => {
    const coordinator = input.coordinatorHarness;
    // Reading availability only matters when the coordinator's harness is native.
    const usable = coordinator !== null && (await available()).includes(coordinator);
    return { harness: usable ? coordinator : "default", source: "fallback", fallbackCause };
  };
  if (!provider) return fallback("no_provider");
  const candidates = await available();
  if (candidates.length < 2) return fallback("single_harness");

  const harnesses = Object.fromEntries(
    candidates.map((harness) => [harnessModelName(harness), HARNESS_DESCRIPTIONS[harness]]),
  );
  const result = await decideWithin(
    provider,
    {
      state: {
        task: { brief: input.redact(input.brief).slice(0, BRIEF_STATE_MAX) },
        specialist_profile: {
          name: input.redact(input.profile.name ?? "").slice(0, PROFILE_NAME_STATE_MAX),
          description: input
            .redact(input.profile.description ?? "")
            .slice(0, PROFILE_DESCRIPTION_STATE_MAX),
        },
        candidate_harnesses: harnesses,
      },
      questions: {
        harness: {
          type: "choice",
          instructions: "Which harness should carry out this task?",
          options: harnesses,
        },
      },
    },
    input.judgment!.context,
    {
      timeoutMs: JUDGMENT_TIMEOUT_MS,
      purpose: "specialist_harness",
      trace: input.judgment!.trace,
    },
  );
  if (!result.ok) return fallback(result.reason);
  const answer = result.answers.harness;
  if (answer?.type !== "choice") return fallback("invalid_answer");
  return {
    harness: HARNESS_MODEL_NAMES[answer.choice as keyof typeof HARNESS_MODEL_NAMES],
    source: "judgment",
  };
}
