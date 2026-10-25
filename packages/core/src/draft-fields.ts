import type { AskDraftFields, AskDraftRecipient } from "@rakazo/contracts";
import { ASK_DRAFT_ADDRESS_MAX_LENGTH, ASK_DRAFT_SUBJECT_MAX_LENGTH } from "@rakazo/contracts";

/** Where a value sits inside a call's arguments or an effect's stored request. */
export type DraftPath = Array<string | number>;

export type RecipientRole = AskDraftRecipient["role"];

export const RECIPIENT_ROLES: readonly RecipientRole[] = ["to", "cc", "bcc"];

export function isRecipientRole(value: unknown): value is RecipientRole {
  return RECIPIENT_ROLES.includes(value as RecipientRole);
}

/** Every line break a client may render, so a card can indent each one. */
export const LINE_BREAKS = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/g;

/**
 * One argument that holds a role's addresses, and how: a string with one address, a string of
 * comma-separated ones, an array of strings, or an array of objects with the address at `address`.
 */
export type RecipientSlot = { role: RecipientRole; path: DraftPath } & (
  | { shape: "one" | "list" | "array" }
  | { shape: "objects"; address: DraftPath }
);

/**
 * Where a draft's recipients and subject sit, so an edit is written back in the shape the tool
 * used. Each role's single-address slots come first: they take one address each, then the first
 * slot that holds many takes the rest.
 */
export type DraftSlots = { recipients: RecipientSlot[]; subject?: DraftPath };

/** What the card counts as too many recipients to show whole. */
export const OUTBOUND_RECIPIENTS_MAX_LENGTH = 4_000;

const ADDRESS = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/;

/** A bare `local@domain` address, the only form a draft shows and sends. */
export function isMailAddress(value: string): boolean {
  // The pattern backtracks badly on long input, so it only ever runs on a bounded string.
  return value.length <= ASK_DRAFT_ADDRESS_MAX_LENGTH && ADDRESS.test(value);
}

/** The addresses in a recipient string, one or comma-separated, or undefined when one is not. */
export function addressesIn(value: string): string[] | undefined {
  const parts = value.split(",").map((part) => part.trim());
  return parts.every(isMailAddress) ? parts : undefined;
}

export function valueAt(value: unknown, path: DraftPath): unknown {
  return path.reduce<unknown>(
    (current, key) =>
      isRecord(current) || Array.isArray(current) ? current[key as never] : undefined,
    value,
  );
}

/** A copy of `value` with `next` at `path`, or undefined when the path does not exist. */
export function withValueAt(value: unknown, path: DraftPath, next: unknown): unknown {
  if (path.length === 0) return next;
  const [key, ...rest] = path;
  if (Array.isArray(value) && typeof key === "number" && key < value.length) {
    const child = withValueAt(value[key], rest, next);
    return child === undefined ? undefined : value.with(key, child);
  }
  if (isRecord(value) && typeof key === "string" && key in value) {
    const child = withValueAt(value[key], rest, next);
    return child === undefined ? undefined : { ...value, [key]: child };
  }
  return undefined;
}

/**
 * A copy of `value` with the argument at `path` set, added when its object lacks it, or removed
 * when `next` is undefined. Undefined when the object itself does not exist.
 */
function withArgumentAt(value: unknown, path: DraftPath, next: unknown): unknown {
  const key = path.at(-1);
  const parentPath = path.slice(0, -1);
  const parent = valueAt(value, parentPath);
  if (!isRecord(parent) || typeof key !== "string") return undefined;
  const { [key]: _dropped, ...rest } = parent;
  return withValueAt(value, parentPath, next === undefined ? rest : { ...parent, [key]: next });
}

/** The addresses a slot holds in `value`, in order. */
export function slotAddresses(value: unknown, slot: RecipientSlot): string[] {
  const held = valueAt(value, slot.path);
  if (typeof held === "string") return held.trim() ? (addressesIn(held) ?? []) : [];
  if (!Array.isArray(held)) return [];
  const leaves = slot.shape === "objects" ? held.map((item) => valueAt(item, slot.address)) : held;
  return leaves.filter((leaf): leaf is string => typeof leaf === "string");
}

/** What a slot holds once given `addresses`; undefined drops the argument. */
function slotValue(slot: RecipientSlot, addresses: string[]): unknown {
  switch (slot.shape) {
    case "one":
      return addresses[0];
    case "list":
      return addresses.length ? addresses.join(", ") : undefined;
    case "array":
      return addresses;
    case "objects":
      return addresses.map((address) =>
        slot.address.reduceRight<unknown>((inner, key) => ({ [key]: inner }), address),
      );
  }
}

/** Every recipient the slots hold in `value`, role by role. */
export function slotRecipients(value: unknown, slots: DraftSlots): AskDraftRecipient[] {
  return RECIPIENT_ROLES.flatMap((role) =>
    slots.recipients
      .filter((slot) => slot.role === role)
      .flatMap((slot) => slotAddresses(value, slot).map((address) => ({ role, address }))),
  );
}

/** The lines a card offers for editing: how many addresses each role takes, and the subject. */
export function askDraftFields(slots: DraftSlots): AskDraftFields {
  const room = (role: RecipientRole) => {
    const held = slots.recipients.filter((slot) => slot.role === role);
    if (!held.length) return undefined;
    return held.some((slot) => slot.shape !== "one") ? null : held.length;
  };
  return {
    to: room("to") ?? null,
    ...(room("cc") !== undefined ? { cc: room("cc") } : {}),
    ...(room("bcc") !== undefined ? { bcc: room("bcc") } : {}),
    ...(slots.subject ? { subject: true as const } : {}),
  };
}

const ROLE_LABELS: Record<RecipientRole, string> = { to: "To", cc: "Cc", bcc: "Bcc" };

/** Why an edit of a draft's recipients or subject cannot be sent, or undefined when it can. */
export function draftFieldsError(
  fields: AskDraftFields | undefined,
  edits: { recipients?: AskDraftRecipient[]; subject?: string },
): string | undefined {
  if (edits.recipients === undefined && edits.subject === undefined) return undefined;
  if (!fields) return "Only the message text can be edited on this draft.";
  if (edits.recipients) {
    const invalid = edits.recipients.find((recipient) => !isMailAddress(recipient.address));
    if (invalid) return `${invalid.address || "An empty address"} is not an email address.`;
    for (const role of RECIPIENT_ROLES) {
      const count = edits.recipients.filter((recipient) => recipient.role === role).length;
      const room = fields[role];
      if (role === "to" && count === 0) return "Add a To address.";
      if (room === undefined && count > 0) return `This message takes no ${ROLE_LABELS[role]}.`;
      if (room && count > room) {
        return room === 1
          ? `This message takes one ${ROLE_LABELS[role]} address.`
          : `This message takes at most ${room} ${ROLE_LABELS[role]} addresses.`;
      }
    }
  }
  if (edits.subject !== undefined) {
    if (!fields.subject) return "This message takes no subject.";
    if (edits.subject.length > ASK_DRAFT_SUBJECT_MAX_LENGTH) {
      return `This subject is longer than ${ASK_DRAFT_SUBJECT_MAX_LENGTH} characters.`;
    }
    if (edits.subject.search(LINE_BREAKS) !== -1) return "A subject fits on one line.";
  }
  return undefined;
}

/**
 * `value` with `recipients` written into the slots, each role's addresses filling its slots in
 * order, or an error when they do not fit. Validate with `draftFieldsError` first.
 */
export function withSlotRecipients(
  value: unknown,
  slots: DraftSlots,
  recipients: AskDraftRecipient[],
): { value: unknown } | { error: string } {
  let next = value;
  for (const role of RECIPIENT_ROLES) {
    let rest = recipients
      .filter((recipient) => recipient.role === role)
      .map((recipient) => recipient.address);
    for (const slot of slots.recipients.filter((each) => each.role === role)) {
      const taken = slot.shape === "one" ? rest.slice(0, 1) : rest;
      rest = rest.slice(taken.length);
      // A line the call left out stays out until it holds an address.
      if (!taken.length && valueAt(next, slot.path) === undefined) continue;
      next = withArgumentAt(next, slot.path, slotValue(slot, taken));
      if (next === undefined) return { error: DRAFT_GONE };
    }
  }
  const length = slots.recipients.reduce(
    (total, slot) => total + serializedLength(valueAt(next, slot.path)),
    0,
  );
  if (length > OUTBOUND_RECIPIENTS_MAX_LENGTH) return { error: "Too many recipients." };
  return { value: next };
}

export const DRAFT_GONE = "This draft can no longer be edited.";

/** How long a value reads on a card: a string as is, anything else as JSON. */
export function serializedLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The slots a stored draft records, or undefined when it has none or they do not parse. */
export function readDraftSlots(value: unknown): DraftSlots | undefined {
  if (!isRecord(value) || !Array.isArray(value.recipients)) return undefined;
  if (value.subject !== undefined && !isPath(value.subject)) return undefined;
  const recipients = value.recipients.filter(isSlot);
  if (recipients.length !== value.recipients.length) return undefined;
  if (!recipients.some((slot) => slot.role === "to")) return undefined;
  return {
    recipients,
    ...(value.subject !== undefined ? { subject: value.subject as DraftPath } : {}),
  };
}

function isSlot(value: unknown): value is RecipientSlot {
  if (!isRecord(value) || !isPath(value.path) || !value.path.length) return false;
  if (!isRecipientRole(value.role)) return false;
  if (value.shape === "objects") return isPath(value.address) && value.address.length > 0;
  return value.shape === "one" || value.shape === "list" || value.shape === "array";
}

export function isPath(value: unknown): value is DraftPath {
  return (
    Array.isArray(value) &&
    value.every((key) => typeof key === "string" || (Number.isInteger(key) && key >= 0))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
