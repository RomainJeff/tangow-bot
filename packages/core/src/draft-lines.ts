import type { AskDraftFields, AskDraftRecipient } from "@tangow/contracts";
import type { RecipientRole } from "./draft-fields.js";
import { isMailAddress, RECIPIENT_ROLES } from "./draft-fields.js";

const SEPARATORS = /[\s,;]+/;

/**
 * A recipient line after its field changed: every address finished by a separator joins the line,
 * or every word when `final` (the field was left or submitted). A word that cannot join, not an
 * address or past the line's room, goes back to the field; a duplicate is dropped.
 */
export function takeAddresses(
  addresses: readonly string[],
  typed: string,
  room: number | null,
  final: boolean,
): { addresses: string[]; typed: string } {
  const cut = final ? typed.length : typed.search(/[^\s,;]*$/);
  const kept = [...addresses];
  let back = "";
  for (const word of typed.slice(0, cut).split(SEPARATORS).filter(Boolean)) {
    if (kept.some((address) => address.toLowerCase() === word.toLowerCase())) continue;
    if (isMailAddress(word) && (room === null || kept.length < room)) kept.push(word);
    else back += `${word} `;
  }
  return { addresses: kept, typed: back + typed.slice(cut) };
}

/** Whether a line's field holds a finished word that could not join the line: Send would leave it. */
export function heldBack(typed: string): boolean {
  return /[^\s,;][\s,;]/.test(typed);
}

/** One role's addresses, in order. */
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
 * A recipient line changed: the new recipients, and the Cc and Bcc lines that stay shown. A Cc or
 * Bcc line the person changed stays open even once emptied, so it never folds under the caret.
 */
export function changeLine(
  recipients: readonly AskDraftRecipient[],
  opened: ReadonlySet<RecipientRole>,
  role: RecipientRole,
  addresses: readonly string[],
): { recipients: AskDraftRecipient[]; opened: ReadonlySet<RecipientRole> } {
  return {
    recipients: withRole(recipients, role, addresses),
    opened: role === "to" || opened.has(role) ? opened : new Set(opened).add(role),
  };
}

/**
 * The Cc and Bcc lines that stay folded until asked for: a role the draft takes that names nobody,
 * holds no typing and was not opened or changed.
 */
export function foldedRoles(
  fields: AskDraftFields | undefined,
  recipients: readonly AskDraftRecipient[],
  typed: Partial<Record<RecipientRole, string>>,
  opened: ReadonlySet<RecipientRole>,
): RecipientRole[] {
  return RECIPIENT_ROLES.filter(
    (role) =>
      role !== "to" &&
      fields?.[role] !== undefined &&
      !addressesOf(recipients, role).length &&
      !typed[role] &&
      !opened.has(role),
  );
}
