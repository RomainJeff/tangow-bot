import type { AskDraft, AskDraftEdits, AskDraftFields, AskDraftRecipient } from "@rakazo/contracts";
import type { RecipientRole } from "@rakazo/core";
import {
  addressesOf,
  draftChanges,
  heldBack,
  RECIPIENT_ROLES,
  sameRecipients,
  takeAddresses,
  withRole,
} from "@rakazo/core";

/** What each recipient row's field holds that has not joined the row yet. */
export type TypedLines = Partial<Record<RecipientRole, string>>;

/**
 * Every row's typing joined as if each field were left, as Done does. `held` says a finished word
 * could not join: the sheet stays open with it marked.
 */
export function finishLines(
  fields: AskDraftFields,
  recipients: readonly AskDraftRecipient[],
  typed: TypedLines,
): { recipients: AskDraftRecipient[]; typed: TypedLines; held: boolean } {
  let next = [...recipients];
  const left: TypedLines = {};
  for (const role of RECIPIENT_ROLES) {
    const room = fields[role];
    if (room === undefined || !typed[role]) continue;
    const taken = takeAddresses(addressesOf(next, role), typed[role], room, true);
    next = withRole(next, role, taken.addresses);
    if (taken.typed) left[role] = taken.typed;
  }
  return {
    recipients: next,
    typed: left,
    held: RECIPIENT_ROLES.some((role) => heldBack(left[role] ?? "")),
  };
}

/** Whether Cancel would lose anything: a change since the sheet opened, or typing in a row. */
export function sheetChanged(
  draft: AskDraft,
  opening: AskDraftEdits,
  edit: AskDraftEdits,
  typed: TypedLines,
): boolean {
  if (Object.values(typed).some(Boolean)) return true;
  const before = draftChanges(draft, opening);
  const now = draftChanges(draft, edit);
  return (
    before.text !== now.text ||
    before.subject !== now.subject ||
    !sameRecipients(before.recipients ?? draft.recipients, now.recipients ?? draft.recipients)
  );
}
