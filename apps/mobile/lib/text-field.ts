import { decideTextCommit, type FieldSaveState } from "@tangow/core";

type TextField = {
  state: FieldSaveState<string>;
  /** The server value, or the value being saved. */
  value: string;
  save: (value: string) => Promise<void>;
  dismiss: () => void;
};

/** What a text field edited in place shows at rest: a failed save keeps its text, so Retry sends what is on screen. */
export function restingText(field: Pick<TextField, "state" | "value">): string {
  return field.state.kind === "failed" ? field.state.value : field.value;
}

/**
 * Leaving a text field edited in place. Untouched text does nothing; text put
 * back to the server value forgets a failed save; changed text is saved trimmed.
 */
export function leaveTextField(
  field: TextField,
  text: string,
  options: { required?: boolean } = {},
): void {
  if (text === restingText(field)) return;
  const decision = decideTextCommit(field.value, text, options);
  if (decision === "commit") void field.save(text.trim());
  else if (decision === "skip") field.dismiss();
}
