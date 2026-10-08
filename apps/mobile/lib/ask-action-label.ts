type AskActionLike = { id: string; label: string; outcome?: "created" | "cancelled" };

const KNOWN_ASK_ACTION_LABELS: Record<string, string> = {
  allow: "Allow once",
  always: "Always allow this tool",
  deny: "Deny",
};

// A card that names an outcome (create_space, spawn_bot, a proposal) sends its own label:
// translate the ones the app knows and show any other as sent.
const KNOWN_OUTCOME_LABELS = new Set([
  "Create space",
  "Create bot",
  "Cancel",
  "Create routine",
  "Not now",
]);

/** The label of an ask action: the server label on an outcome card, else the approval id's. */
export function askActionLabel(action: AskActionLike, t: (message: string) => string): string {
  if (action.outcome)
    return KNOWN_OUTCOME_LABELS.has(action.label) ? t(action.label) : action.label;
  return Object.hasOwn(KNOWN_ASK_ACTION_LABELS, action.id)
    ? t(KNOWN_ASK_ACTION_LABELS[action.id]!)
    : action.label;
}
