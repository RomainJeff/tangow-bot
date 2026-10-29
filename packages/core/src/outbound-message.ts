import type { AskDraftConversation, AskDraftRecipient } from "@rakazo/contracts";
import { ASK_DRAFT_SUBJECT_MAX_LENGTH } from "@rakazo/contracts";
import { connectorKindFromToolName, isEmailConnectorKind } from "./action-approval.js";
import type { DraftPath, DraftSlots, RecipientRole, RecipientSlot } from "./draft-fields.js";
import {
  addressesIn,
  isMailAddress,
  isRecipientRole,
  isRecord,
  LINE_BREAKS,
  OUTBOUND_RECIPIENTS_MAX_LENGTH,
  RECIPIENT_ROLES,
  serializedLength,
  slotRecipients,
} from "./draft-fields.js";
import { draftTextError } from "./outbound-draft.js";

/**
 * One tool invocation a connector call performs, in the connector's own naming, with the tool's
 * input schema when the call itself is that tool's.
 */
export type OutboundAction = {
  toolName: string;
  args: Record<string, unknown>;
  schema?: Record<string, unknown>;
};

export type OutboundRecipient = AskDraftRecipient;

export type OutboundDraft = {
  /** The app that sends, as approval rules name it. */
  connectorKind: string;
  recipients: OutboundRecipient[];
  subject?: string;
  body: string;
  /** The sending account, when the call names it by address. */
  account?: string;
  /** The action's arguments with HTML and signature off: what leaves is what the card shows. */
  args: Record<string, unknown>;
  /** Where the body sits in `args`. */
  textPath: DraftPath;
  /** Where the recipients and subject sit in `args`, when every one can be written back. */
  fields?: DraftSlots;
  /** A chat message's recipient as its app named it; the one recipient holds the app's id. */
  conversation?: AskDraftConversation;
};

/**
 * How a connector call that may send a message is gated. `draft` is a message whose every
 * argument is explained; `chat` is one sent to a conversation, a draft only once its app names
 * who that is; `classic` looks like a send the reader cannot fully show; `none` is not a send it
 * knows and keeps today's gate.
 */
export type OutboundCall =
  | { kind: "none" }
  | { kind: "draft"; draft: OutboundDraft }
  | { kind: "chat"; draft: OutboundDraft }
  | { kind: "classic" }
  | { kind: "refuse"; error: string };

/** Free text the bot writes beside a message, anew on each retry, which says nothing of where it goes. */
const FREE_TEXT_NOTES = new Set(["thought"]);

/**
 * What a draft would send, as the key of its effect: the tool, the app, the recipients, the
 * subject, the text, the sending account, and every argument that says where it lands (a thread,
 * a message or a reply it answers, a broadcast). Only the bot's own free-text notes are left out,
 * so the same mail issued again with other words there is the same effect, and the same text
 * in another thread remains a different message.
 */
export function outboundDraftIdentity(draft: OutboundDraft): Record<string, unknown> {
  const addressing = Object.entries(draft.args)
    .filter(([key, value]) => {
      const role = FIELD_ROLES[fieldKey(key)];
      return (
        (role === "inert" || role === "toggle") &&
        !FREE_TEXT_NOTES.has(fieldKey(key)) &&
        value !== undefined
      );
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return {
    app: draft.connectorKind,
    ...(addressing.length === 0 ? {} : { addressing: Object.fromEntries(addressing) }),
    recipients: draft.recipients
      .map((recipient) => `${recipient.role} ${recipient.address.toLowerCase()}`)
      .sort(),
    ...(draft.subject === undefined ? {} : { subject: draft.subject }),
    body: draft.body,
    ...(draft.account === undefined ? {} : { account: draft.account.toLowerCase() }),
  };
}

/** The longest a value shows on the card of a send it cannot read, before it is cut and marked. */
export const CARD_VALUE_MAX_LENGTH = 1_000;
const CARD_LINES_MAX_LENGTH = 4_000;
const MAX_ARGUMENT_DEPTH = 32;

type FieldRole =
  | OutboundRecipient["role"]
  | "text"
  | "subject"
  | "sender"
  | "flag"
  | "attachment"
  | "conversation"
  | "toggle"
  | "inert";

/** Argument names, lowercased without `_` or `-`. A connector with new names adds a line here. */
const FIELD_ROLES: Record<string, FieldRole> = {
  to: "to",
  recipient: "to",
  recipients: "to",
  recipientemail: "to",
  extrarecipients: "to",
  toemail: "to",
  torecipients: "to",
  toaddress: "to",
  toaddresses: "to",
  recipientaddress: "to",
  sendto: "to",
  emailaddress: "to",
  cc: "cc",
  ccemails: "cc",
  ccrecipients: "cc",
  bcc: "bcc",
  bccemails: "bcc",
  bccrecipients: "bcc",
  body: "text",
  messagebody: "text",
  message: "text",
  text: "text",
  content: "text",
  markdowntext: "text",
  subject: "subject",
  from: "sender",
  fromemail: "sender",
  fromaddress: "sender",
  sender: "sender",
  userid: "sender",
  account: "sender",
  ishtml: "flag",
  html: "flag",
  includesignature: "flag",
  signature: "flag",
  attachment: "attachment",
  attachments: "attachment",
  file: "attachment",
  files: "attachment",
  attachmentid: "attachment",
  attachmentids: "attachment",
  channel: "conversation",
  channelid: "conversation",
  conversation: "conversation",
  conversationid: "conversation",
  threadid: "inert",
  threadts: "inert",
  messageid: "inert",
  savetosentitems: "inert",
  thought: "inert",
  replybroadcast: "toggle",
  unfurllinks: "toggle",
  unfurlmedia: "toggle",
  unfurlapplinks: "toggle",
};

const INHERITED_ROLES = new Set<FieldRole | undefined>(["to", "cc", "bcc", "sender", "attachment"]);
const SEND_VERBS = new Set(["send", "sendmail", "sendemail", "reply", "forward"]);
const CHAT_VERBS = new Set(["send", "post"]);

export const REFUSE_UNSHOWABLE: OutboundCall = {
  kind: "refuse",
  error: "Too many arguments to show the user. Send with fewer fields at a time.",
};

type Reading = {
  recipients: OutboundRecipient[];
  texts: string[];
  subjects: string[];
  sender?: string;
  conversations: string[];
  addressed: boolean;
  unexplained: boolean;
  /** Every recipient-role value, nested ones included: the card prints each whole. */
  recipientValues: unknown[];
  tooDeep: boolean;
  /** A recipient sits inside another argument, where the classic card could cut it. */
  buried: boolean;
};

/** Reads an outgoing call; chat sends require an app whose recipients the adapter can name. */
export function readOutboundCall(
  action: OutboundAction,
  connectorKinds: string[] = [],
  chatApps: ReadonlySet<string> = new Set(),
): OutboundCall {
  const words = toolWords(action.toolName);
  const connectorKind = connectorKindFromToolName(action.toolName, connectorKinds);
  const sends = words.some((word) => SEND_VERBS.has(word));
  const chats = chatApps.has(connectorKind) && words.some((word) => CHAT_VERBS.has(word));
  if (!sends && !chats) return { kind: "none" };
  const reading: Reading = {
    recipients: [],
    texts: [],
    subjects: [],
    conversations: [],
    addressed: false,
    unexplained: false,
    recipientValues: [],
    tooDeep: false,
    buried: false,
  };
  const args = readValue(action.args, undefined, reading, 0) as Record<string, unknown>;
  const mail =
    sends &&
    (reading.addressed ||
      words.some((word) => word.endsWith("mail")) ||
      isEmailConnectorKind(connectorKind));
  if (!mail) {
    return chats ? readChat(action, args, reading, connectorKind) : { kind: "none" };
  }
  if (reading.tooDeep) {
    return { kind: "refuse", error: "Send this message with simpler arguments." };
  }
  const recipientsLength = reading.recipientValues.reduce<number>(
    (total, value) => total + serializedLength(value),
    0,
  );
  if (recipientsLength > OUTBOUND_RECIPIENTS_MAX_LENGTH) {
    return {
      kind: "refuse",
      error: "Too many recipients to show the user. Send to fewer people at a time.",
    };
  }
  const texts = textLeaves(args);
  if (
    words.includes("forward") ||
    reading.unexplained ||
    reading.conversations.length > 0 ||
    texts.length !== 1 ||
    reading.subjects.length > 1 ||
    reading.subjects.some((subject) => subject.length > ASK_DRAFT_SUBJECT_MAX_LENGTH) ||
    // A subject the card shows on one line could hide what follows a break.
    reading.subjects.some((subject) => subject.search(LINE_BREAKS) !== -1) ||
    !reading.recipients.some((recipient) => recipient.role === "to")
  ) {
    if (reading.buried) {
      return { kind: "refuse", error: "Put the recipients in the to, cc and bcc arguments." };
    }
    return cardFitsArguments(action.args) ? { kind: "classic" } : REFUSE_UNSHOWABLE;
  }
  const [{ path: textPath, value: body }] = texts as [{ path: DraftPath; value: string }];
  const error = draftTextError(body);
  if (error) return { kind: "refuse", error };
  return {
    kind: "draft",
    draft: {
      connectorKind,
      recipients: reading.recipients,
      subject: reading.subjects[0],
      body,
      account: reading.sender,
      args,
      textPath,
      fields: draftSlots(args, action.schema, reading.recipients),
    },
  };
}

/**
 * A chat app's send: one conversation and one text, every other argument explained, or else the
 * classic card. The card names the conversation only once its app has, so it is not yet a draft.
 */
function readChat(
  action: OutboundAction,
  args: Record<string, unknown>,
  reading: Reading,
  connectorKind: string,
): OutboundCall {
  if (reading.tooDeep) {
    return { kind: "refuse", error: "Send this message with simpler arguments." };
  }
  const texts = textLeaves(args);
  if (
    reading.unexplained ||
    reading.recipientValues.length > 0 ||
    reading.subjects.length > 0 ||
    reading.sender !== undefined ||
    reading.conversations.length !== 1 ||
    texts.length !== 1
  ) {
    return cardFitsArguments(action.args) ? { kind: "classic" } : REFUSE_UNSHOWABLE;
  }
  const [{ path: textPath, value: body }] = texts as [{ path: DraftPath; value: string }];
  const error = draftTextError(body);
  if (error) return { kind: "refuse", error };
  return {
    kind: "chat",
    draft: {
      connectorKind,
      recipients: [{ role: "to", address: reading.conversations[0]! }],
      body,
      args,
      textPath,
    },
  };
}

function toolWords(toolName: string): string[] {
  return toolName
    .replace(/^mcp__.+?__/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

function readValue(
  value: unknown,
  role: FieldRole | undefined,
  reading: Reading,
  depth: number,
): unknown {
  if (depth > MAX_ARGUMENT_DEPTH) {
    reading.unexplained = true;
    reading.tooDeep = true;
    return value;
  }
  if (role === "flag") {
    if (typeof value === "boolean") return false;
    if (value != null) reading.unexplained = true;
    return value;
  }
  // An option that changes nothing the card shows, sent as the bot set it.
  if (role === "toggle") {
    if (typeof value !== "boolean" && value != null) reading.unexplained = true;
    return value;
  }
  if (role === "inert" && value && typeof value === "object") {
    reading.unexplained = true;
    return value;
  }
  // The card shows a message's text as one string, so a container could hide fields inside it.
  if ((role === "text" || role === "subject") && value && typeof value === "object") {
    reading.unexplained = true;
  }
  if (Array.isArray(value)) return value.map((item) => readValue(item, role, reading, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (INHERITED_ROLES.has(role)) return [key, readValue(child, role, reading, depth + 1)];
        const childRole = FIELD_ROLES[fieldKey(key)];
        if (isRecipientRole(childRole)) {
          reading.recipientValues.push(child);
          if (depth > 0) reading.buried = true;
        }
        // A send takes its conversation as an argument of its own, never inside another one.
        if (childRole === "conversation" && depth > 0) reading.unexplained = true;
        return [key, readValue(child, childRole, reading, depth + 1)];
      }),
    );
  }
  if (typeof value === "string" && value.trim()) readString(value, role, reading);
  if ((typeof value === "boolean" || typeof value === "number") && role !== "inert") {
    reading.unexplained = true;
  }
  return value;
}

function readString(value: string, role: FieldRole | undefined, reading: Reading): void {
  switch (role) {
    case "to":
    case "cc":
    case "bcc": {
      reading.addressed ||= value.includes("@");
      const addresses = addressesIn(value);
      if (addresses) for (const address of addresses) reading.recipients.push({ role, address });
      else reading.unexplained = true;
      return;
    }
    case "text":
      reading.texts.push(value);
      return;
    case "subject":
      reading.subjects.push(value);
      return;
    case "sender": {
      // The card names one sending account, so only that bare address (or "me") is explained.
      const sender = value.trim();
      if (sender.toLowerCase() === "me") return;
      const { sender: first } = reading;
      if (!isMailAddress(sender) || (first && first.toLowerCase() !== sender.toLowerCase())) {
        reading.unexplained = true;
      } else reading.sender ??= sender;
      return;
    }
    case "conversation":
      reading.conversations.push(value);
      return;
    case "inert":
      return;
    default:
      reading.unexplained = true;
  }
}

/** Whether an argument name carries recipients, so a card never shortens it. */
export function isRecipientField(key: string): boolean {
  return isRecipientRole(FIELD_ROLES[fieldKey(key)]);
}

/** Arguments a card shows whole: recipients and conversations. */
export function isWholeField(key: string): boolean {
  const field = fieldKey(key);
  return isRecipientField(key) || FIELD_ROLES[field] === "conversation";
}

/**
 * Whether the card of a send it cannot read can show every argument: whole fields in full,
 * the others each cut at `CARD_VALUE_MAX_LENGTH`, all within a fixed size.
 */
export function cardFitsArguments(args: Record<string, unknown>): boolean {
  let whole = 0;
  let lines = 0;
  for (const [key, value] of Object.entries(args)) {
    const length = serializedLength(value);
    if (isWholeField(key)) whole += length;
    else lines += key.length + 3 + Math.min(length, CARD_VALUE_MAX_LENGTH) + 1;
  }
  return whole <= OUTBOUND_RECIPIENTS_MAX_LENGTH && lines <= CARD_LINES_MAX_LENGTH;
}

/** Every string the reader takes as the body, blank ones included, with where it sits. */
function textLeaves(
  value: unknown,
  role?: FieldRole,
  path: DraftPath = [],
): Array<{ path: DraftPath; value: string }> {
  if (role === "flag") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => textLeaves(item, role, [...path, index]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      textLeaves(child, INHERITED_ROLES.has(role) ? role : FIELD_ROLES[fieldKey(key)], [
        ...path,
        key,
      ]),
    );
  }
  return role === "text" && typeof value === "string" ? [{ path, value }] : [];
}

function fieldKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

type FieldLeaf = { role: RecipientRole | "subject"; path: DraftPath; value: unknown };

/** Each recipient and subject argument, wherever it sits, with the value it holds. */
function fieldLeaves(value: unknown, path: DraftPath = []): FieldLeaf[] {
  const children: Array<[string | number, unknown]> = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : isRecord(value)
      ? Object.entries(value)
      : [];
  return children.flatMap(([key, child]) => {
    const role = typeof key === "string" ? FIELD_ROLES[fieldKey(key)] : undefined;
    if (isRecipientRole(role) || role === "subject") {
      return [{ role, path: [...path, key], value: child }];
    }
    return role === undefined ? fieldLeaves(child, [...path, key]) : [];
  });
}

/**
 * Where a draft's recipients and subject sit, so edits go back in the tool's own shapes. A role the
 * call leaves out is offered from the tool's schema when known: one argument that holds many
 * addresses, or else the first that holds one. Undefined when a recipient argument has a shape
 * this cannot write back: the draft then only lets its text change.
 */
function draftSlots(
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
  shown: OutboundRecipient[],
): DraftSlots | undefined {
  const leaves = fieldLeaves(args);
  const present: RecipientSlot[] = [];
  for (const { role, path, value } of leaves) {
    if (role === "subject" || value == null) continue;
    const slot = slotOf(role, path, value, propertySchema(schema, path));
    if (!slot) return undefined;
    present.push(slot);
  }
  const offered = Object.entries(schemaProperties(schema)).flatMap(([key, property]) => {
    const role = FIELD_ROLES[fieldKey(key)];
    if (!isRecipientRole(role) || key in args) return [];
    const slot = slotOf(role, [key], emptyOf(property), property);
    return slot ? [slot] : [];
  });
  const recipients = RECIPIENT_ROLES.flatMap((role) => {
    const own = present.filter((slot) => slot.role === role);
    const absent = offered.filter((slot) => slot.role === role);
    const extra = own.some((slot) => slot.shape !== "one")
      ? undefined
      : (absent.find((slot) => slot.shape !== "one") ??
        (own.length ? undefined : absent.find((slot) => slot.shape === "one")));
    return [...own, ...(extra ? [extra] : [])].sort(
      (left, right) => Number(left.shape !== "one") - Number(right.shape !== "one"),
    );
  });
  const subjects = leaves.filter(
    (leaf) => leaf.role === "subject" && typeof leaf.value === "string",
  );
  const slots = { recipients, ...(subjects.length === 1 ? { subject: subjects[0]!.path } : {}) };
  // The slots must read back exactly what the card shows, or an edit would write a shape the tool
  // did not use and the bot would read a different list.
  return recipientKey(slotRecipients(args, slots)) === recipientKey(shown) ? slots : undefined;
}

function recipientKey(recipients: OutboundRecipient[]): string {
  return recipients
    .map((recipient) => `${recipient.role} ${recipient.address}`)
    .sort()
    .join("\n");
}

/** How `value` holds a role's addresses, or undefined when it cannot be written back as is. */
function slotOf(
  role: RecipientRole,
  path: DraftPath,
  value: unknown,
  property: Record<string, unknown> | undefined,
): RecipientSlot | undefined {
  if (typeof value === "string") {
    const addresses = value.trim() ? addressesIn(value) : [];
    if (!addresses) return undefined;
    return { role, path, shape: addresses.length > 1 ? "list" : "one" };
  }
  if (!Array.isArray(value)) return undefined;
  if (value.every((item) => typeof item === "string")) {
    if (value.some((item) => addressesIn(item)?.length !== 1)) return undefined;
    const items = isRecord(property?.items) ? property.items : undefined;
    if (value.length || !hasType(items, "object")) return { role, path, shape: "array" };
    const address = addressPath(emptyOf(items));
    return address ? { role, path, shape: "objects", address } : undefined;
  }
  const paths = value.map(addressPath);
  const [first] = paths;
  if (!first || paths.some((each) => each?.join("\0") !== first.join("\0"))) return undefined;
  return { role, path, shape: "objects", address: first };
}

/** The one place an address sits in an item, or a schema item's skeleton. */
function addressPath(item: unknown): DraftPath | undefined {
  const leaves: DraftPath[] = [];
  const walk = (value: unknown, path: string[]) => {
    if (isRecord(value))
      for (const [key, child] of Object.entries(value)) walk(child, [...path, key]);
    else leaves.push(path);
  };
  if (!isRecord(item)) return undefined;
  walk(item, []);
  return leaves.length === 1 && leaves[0]!.length ? leaves[0] : undefined;
}

/**
 * An empty value of a schema's type, objects spelled out down to their leaves so an item's address
 * path can be read from it.
 */
function emptyOf(schema: unknown): unknown {
  if (!isRecord(schema)) return undefined;
  if (hasType(schema, "string")) return "";
  if (hasType(schema, "array")) return [];
  if (hasType(schema, "object")) {
    return Object.fromEntries(
      Object.entries(schemaProperties(schema)).map(([key, child]) => [key, emptyOf(child)]),
    );
  }
  return undefined;
}

function hasType(schema: Record<string, unknown> | undefined, type: string): boolean {
  const declared = schema?.type;
  return declared === type || (Array.isArray(declared) && declared.includes(type));
}

function schemaProperties(schema: unknown): Record<string, Record<string, unknown>> {
  const properties = isRecord(schema) ? schema.properties : undefined;
  if (!isRecord(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties).filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1]),
    ),
  );
}

/** The schema of a top-level argument; nested arguments go without. */
function propertySchema(
  schema: Record<string, unknown> | undefined,
  path: DraftPath,
): Record<string, unknown> | undefined {
  return path.length === 1 ? schemaProperties(schema)[String(path[0])] : undefined;
}
