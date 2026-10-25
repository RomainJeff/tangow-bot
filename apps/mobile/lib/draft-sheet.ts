import type { AskDraftFields, AskDraftRecipient } from "@rakazo/contracts";
import type { RecipientRole } from "@rakazo/core";
import { heldBack, RECIPIENT_ROLES, takeAddresses } from "@rakazo/core";

/** What each recipient row's field holds that has not joined the row yet. */
export type TypedLines = Partial<Record<RecipientRole, string>>;

export function addressesOf(recipients: readonly AskDraftRecipient[], role: RecipientRole) {
  return recipients.filter((recipient) => recipient.role === role).map((each) => each.address);
}

/** The recipients with one role's addresses replaced, kept in To, Cc, Bcc order. */
export function withRole(
  recipients: readonly AskDraftRecipient[],
  role: RecipientRole,
  addresses: readonly string[],
): AskDraftRecipient[] {
  return RECIPIENT_ROLES.flatMap((each) =>
    each === role
      ? addresses.map((address) => ({ role, address }))
      : recipients.filter((recipient) => recipient.role === each),
  );
}

/**
 * The Cc and Bcc rows the sheet keeps folded behind "Cc/Bcc": a role the draft takes that names
 * nobody, holds no typing and was not opened.
 */
export function foldedRoles(
  fields: AskDraftFields,
  recipients: readonly AskDraftRecipient[],
  typed: TypedLines,
  opened: ReadonlySet<RecipientRole>,
): RecipientRole[] {
  return RECIPIENT_ROLES.filter(
    (role) =>
      role !== "to" &&
      fields[role] !== undefined &&
      !addressesOf(recipients, role).length &&
      !typed[role] &&
      !opened.has(role),
  );
}

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
