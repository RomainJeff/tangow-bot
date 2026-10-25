import { isMailAddress } from "./draft-fields.js";

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
