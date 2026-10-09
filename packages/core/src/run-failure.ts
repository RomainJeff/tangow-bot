import type { RunFailureKind, RunStatus } from "@rakazo/contracts";

export const MISSING_MODEL_MESSAGE = "Connect a model in Settings before running bots.";
export const MODEL_PROVIDER_NOT_CONNECTED_MESSAGE = "Connect that model provider first";
export const UNKNOWN_MODEL_MESSAGE = "Unknown model for that provider";

const MISSING_MODEL_ERRORS: ReadonlySet<string> = new Set([
  MISSING_MODEL_MESSAGE,
  MODEL_PROVIDER_NOT_CONNECTED_MESSAGE,
  UNKNOWN_MODEL_MESSAGE,
]);

const COMPUTER_ERROR = /computer|Box API|sandbox|takeover/i;

const PROVIDER_ERROR =
  /\b(?:401|402|403|404|408|409|413|429|5\d\d)\b|rate.?limit|too many requests|overloaded|unauthori[sz]ed|forbidden|api.?key|quota|billing|insufficient|credit|context (?:length|window)|timed? ?out|fetch failed|ECONN\w*|ENOTFOUND|OpenCode|provider|model/i;

/** Only a failed run has a failure kind. Unrecognised text is `other`, never guessed as a provider fault. */
export function classifyRunFailure(
  status: RunStatus,
  error: string | null | undefined,
): RunFailureKind | null {
  if (status !== "failed") return null;
  const text = error?.trim();
  if (!text) return "other";
  if (MISSING_MODEL_ERRORS.has(text)) return "missing_model";
  if (COMPUTER_ERROR.test(text)) return "computer";
  if (PROVIDER_ERROR.test(text)) return "provider";
  return "other";
}
