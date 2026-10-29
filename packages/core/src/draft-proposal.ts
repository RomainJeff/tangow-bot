import type { AskDraftRecipient } from "@rakazo/contracts";
import { ASK_DRAFT_ADDRESS_MAX_LENGTH, ASK_DRAFT_SUBJECT_MAX_LENGTH } from "@rakazo/contracts";
import type { DraftPath, RecipientSlot } from "./draft-fields.js";
import {
  addressesIn,
  isMailAddress,
  isPath,
  isRecipientRole,
  isRecord,
  LINE_BREAKS,
  OUTBOUND_RECIPIENTS_MAX_LENGTH,
  RECIPIENT_ROLES,
  serializedLength,
  slotAddresses,
  valueAt,
} from "./draft-fields.js";
import type { DraftBinding } from "./outbound-draft.js";
import { draftTextError } from "./outbound-draft.js";

type Located = { path: DraftPath; value: string };

/**
 * What a model proposes to show of a call on the draft card: each field with where it sits in the
 * call's arguments, and every other argument it says changes nothing the card shows.
 */
export type DraftProposal =
  | {
      card: "mail";
      recipients: Array<RecipientSlot & { addresses: string[] }>;
      subject?: Located;
      body: Located;
      account?: Located;
      unshown: DraftPath[];
    }
  | { card: "chat"; conversation: Located; body: Located; unshown: DraftPath[] };

const PATH = {
  type: "array",
  description: "The keys and array indexes from the arguments' root to the value.",
  items: { anyOf: [{ type: "string" }, { type: "integer" }] },
};

const located = (description: string) => ({
  type: "object",
  description: `${description} Its value is copied exactly as the arguments hold it.`,
  properties: { path: PATH, value: { type: "string" } },
  required: ["path", "value"],
});

const UNSHOWN = {
  type: "array",
  description:
    "Every other argument, each one only when it changes nothing the recipients receive, such as a thread id, a note to yourself, or a link preview toggle.",
  items: PATH,
};

/**
 * The cards a model can fill in for a call that sends one message, each an object JSON Schema it
 * answers with instead of text, kept to what strict structured output accepts.
 */
export const DRAFT_CARDS = {
  mail: {
    name: "mail_card",
    description: "An email the call sends, whole.",
    schema: {
      type: "object",
      properties: {
        recipients: {
          type: "array",
          description:
            "Every recipient argument, and, from the schema, each recipient argument the call leaves out, with no addresses.",
          items: {
            type: "object",
            properties: {
              role: { type: "string", enum: [...RECIPIENT_ROLES] },
              path: PATH,
              shape: {
                type: "string",
                enum: ["one", "list", "array", "objects"],
                description:
                  "one: a string with one address; list: a string of comma-separated addresses; array: an array of address strings; objects: an array of objects each holding only its address.",
              },
              address: { ...PATH, description: "For objects, where each one holds its address." },
              addresses: {
                type: "array",
                description: "The addresses the argument holds, in order.",
                items: { type: "string" },
              },
            },
            required: ["role", "path", "shape", "addresses"],
          },
        },
        subject: located("The subject, when the call has one."),
        body: located("The text of the message."),
        account: located("The sending address, when the arguments name one."),
        unshown: UNSHOWN,
      },
      required: ["recipients", "body", "unshown"],
    },
  },
  chat: {
    name: "chat_card",
    description: "A chat message the call sends to one conversation, whole.",
    schema: {
      type: "object",
      properties: {
        conversation: located("The exact id of the conversation the message goes to."),
        body: located("The text of the message."),
        unshown: UNSHOWN,
      },
      required: ["conversation", "body", "unshown"],
    },
  },
} as const;

/**
 * The proposal a model's answer stands for, or undefined when it is not one. An optional field
 * may come as null, as strict structured output sends it.
 */
export function readDraftProposal(answer: {
  name: string;
  value: Record<string, unknown>;
}): DraftProposal | undefined {
  const { value } = answer;
  const body = locatedIn(value.body);
  const unshown = value.unshown;
  if (!body || !Array.isArray(unshown) || !unshown.every(isPath)) return undefined;
  if (answer.name === DRAFT_CARDS.chat.name) {
    const conversation = locatedIn(value.conversation);
    return conversation ? { card: "chat", conversation, body, unshown } : undefined;
  }
  if (answer.name !== DRAFT_CARDS.mail.name || !Array.isArray(value.recipients)) return undefined;
  const recipients = value.recipients.flatMap((slot) => {
    const read = proposedSlot(slot);
    return read ? [read] : [];
  });
  if (recipients.length !== value.recipients.length) return undefined;
  const subject = value.subject == null ? undefined : locatedIn(value.subject);
  const account = value.account == null ? undefined : locatedIn(value.account);
  if ((value.subject != null && !subject) || (value.account != null && !account)) {
    return undefined;
  }
  return {
    card: "mail",
    recipients,
    ...(subject ? { subject } : {}),
    body,
    ...(account ? { account } : {}),
    unshown,
  };
}

function locatedIn(value: unknown): Located | undefined {
  if (!isRecord(value) || !isPath(value.path) || !value.path.length) return undefined;
  return typeof value.value === "string" ? { path: value.path, value: value.value } : undefined;
}

function proposedSlot(value: unknown): (RecipientSlot & { addresses: string[] }) | undefined {
  if (!isRecord(value) || !isPath(value.path) || !value.path.length) return undefined;
  if (!isRecipientRole(value.role) || !Array.isArray(value.addresses)) return undefined;
  if (!value.addresses.every((address) => typeof address === "string")) return undefined;
  const base = { role: value.role, path: value.path, addresses: value.addresses as string[] };
  if (value.shape === "objects") {
    return isPath(value.address) && value.address.length > 0
      ? { ...base, shape: "objects", address: value.address }
      : undefined;
  }
  return value.shape === "one" || value.shape === "list" || value.shape === "array"
    ? { ...base, shape: value.shape }
    : undefined;
}

/**
 * The draft a proposal stands for, read back from the arguments themselves, or undefined when any
 * part of it does not hold: a value that is not where it says, a field another one overlaps, a
 * recipient shape that could not take an edit back, or an argument it neither shows nor names as
 * unshown. Paths are relative to `args`.
 */
export function acceptDraftProposal(
  args: Record<string, unknown>,
  proposal: DraftProposal,
  schema?: Record<string, unknown>,
): DraftBinding | undefined {
  const { body } = proposal;
  if (!holds(args, body) || draftTextError(body.value)) return undefined;
  if (proposal.card === "chat") {
    const { conversation } = proposal;
    if (!holds(args, conversation) || !conversation.value.trim()) return undefined;
    if (conversation.value.length > ASK_DRAFT_ADDRESS_MAX_LENGTH) return undefined;
    if (!accountsForEveryArgument(args, [body.path, conversation.path], proposal.unshown))
      return undefined;
    return { path: body.path, proposed: body.value, chat: { path: conversation.path } };
  }
  const { subject, account } = proposal;
  if (subject && !holds(args, subject)) return undefined;
  if (subject && subject.value.length > ASK_DRAFT_SUBJECT_MAX_LENGTH) return undefined;
  if (subject && subject.value.search(LINE_BREAKS) !== -1) return undefined;
  if (account && (!holds(args, account) || !isMailAddress(account.value))) return undefined;
  const slots = proposal.recipients.map(({ addresses: _, ...slot }) => slot);
  if (!proposal.recipients.every((slot) => slotFits(args, slot, schema))) return undefined;
  const recipients: AskDraftRecipient[] = RECIPIENT_ROLES.flatMap((role) =>
    proposal.recipients
      .filter((slot) => slot.role === role)
      .flatMap((slot) => slot.addresses.map((address) => ({ role, address }))),
  );
  if (!recipients.some((recipient) => recipient.role === "to")) return undefined;
  const length = slots.reduce(
    (total, slot) => total + serializedLength(valueAt(args, slot.path)),
    0,
  );
  if (length > OUTBOUND_RECIPIENTS_MAX_LENGTH) return undefined;
  const fieldPaths = [
    body.path,
    ...slots.map((slot) => slot.path),
    ...(subject ? [subject.path] : []),
    ...(account ? [account.path] : []),
  ];
  if (!accountsForEveryArgument(args, fieldPaths, proposal.unshown)) return undefined;
  return {
    path: body.path,
    proposed: body.value,
    fields: {
      recipients: [...slots].sort(
        (left, right) => Number(left.shape !== "one") - Number(right.shape !== "one"),
      ),
      ...(subject ? { subject: subject.path } : {}),
      proposed: { recipients, ...(subject ? { subject: subject.value } : {}) },
    },
    ...(account ? { account: account.value } : {}),
  };
}

function holds(args: unknown, field: Located): boolean {
  return valueAt(args, field.path) === field.value;
}

function slotFits(
  args: Record<string, unknown>,
  slot: RecipientSlot & { addresses: string[] },
  schema: Record<string, unknown> | undefined,
): boolean {
  if (typeof slot.path.at(-1) !== "string") return false;
  if (!slot.addresses.every(isMailAddress)) return false;
  const value = valueAt(args, slot.path);
  if (value === undefined) {
    if (slot.addresses.length || slot.path.length !== 1) return false;
    const property = schemaProperty(schema, String(slot.path[0]));
    if (slot.shape === "one" || slot.shape === "list") return hasType(property, "string");
    if (!hasType(property, "array")) return false;
    const items = isRecord(property?.items) ? property.items : undefined;
    if (slot.shape !== "objects") return hasType(items, "string");
    const leaf = slot.address.reduce<Record<string, unknown> | undefined>(
      (at, key) => (hasType(at, "object") ? schemaProperty(at, String(key)) : undefined),
      items,
    );
    return hasType(leaf, "string");
  }
  const same = (held: string[]) =>
    held.length === slot.addresses.length &&
    held.every((address, index) => address === slot.addresses[index]);
  switch (slot.shape) {
    case "one":
    case "list": {
      if (typeof value !== "string") return false;
      const held = value.trim() ? addressesIn(value) : [];
      if (!held || (slot.shape === "one" && held.length > 1)) return false;
      return same(held);
    }
    case "array":
      return (
        Array.isArray(value) &&
        value.every((item) => typeof item === "string" && isMailAddress(item)) &&
        same(value as string[])
      );
    case "objects":
      return (
        Array.isArray(value) &&
        value.every((item) => onlyLeaf(item, slot.address)) &&
        same(slotAddresses(args, slot))
      );
  }
}

function onlyLeaf(item: unknown, address: DraftPath): boolean {
  let current = item;
  for (const key of address) {
    if (!isRecord(current) || Object.keys(current).length !== 1 || !(String(key) in current)) {
      return false;
    }
    current = current[String(key)];
  }
  return typeof current === "string";
}

function hasType(schema: Record<string, unknown> | undefined, type: string): boolean {
  const declared = schema?.type;
  return declared === type || (Array.isArray(declared) && declared.includes(type));
}

function schemaProperty(
  schema: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const properties = schema?.properties;
  const property = isRecord(properties) ? properties[key] : undefined;
  return isRecord(property) ? property : undefined;
}

function accountsForEveryArgument(
  args: Record<string, unknown>,
  fields: DraftPath[],
  unshown: DraftPath[],
): boolean {
  const named = [...fields, ...unshown];
  for (const [index, path] of named.entries()) {
    if (unshown.includes(path) && valueAt(args, path) === undefined) return false;
    if (named.some((other, at) => at !== index && within(other, path))) return false;
  }
  return leaves(args).every((leaf) => named.some((path) => within(path, leaf)));
}

function within(outer: DraftPath, path: DraftPath): boolean {
  return outer.length <= path.length && outer.every((key, index) => key === path[index]);
}

function leaves(value: unknown, path: DraftPath = []): DraftPath[] {
  const children: Array<[string | number, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : isRecord(value)
      ? Object.entries(value)
      : [];
  if (!children.length) return [path];
  return children.flatMap(([key, child]) => leaves(child, [...path, key]));
}
