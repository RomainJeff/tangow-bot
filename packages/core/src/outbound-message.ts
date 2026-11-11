import type { AskDraftRecipient } from "@tangow/contracts";
import { ASK_DRAFT_SUBJECT_MAX_LENGTH } from "@tangow/contracts";
import { connectorKindFromToolName, isEmailConnectorKind } from "./action-approval.js";
import type { RecipientRole } from "./draft-fields.js";
import {
  addressesIn,
  isMailAddress,
  isRecipientRole,
  LINE_BREAKS,
  OUTBOUND_RECIPIENTS_MAX_LENGTH,
  serializedLength,
} from "./draft-fields.js";
import { draftTextError } from "./outbound-draft.js";

/** One tool invocation a connector call performs, in the connector's own naming. */
export type OutboundAction = { toolName: string; args: Record<string, unknown> };

/**
 * How a connector call that may send a message is gated. `message` is a send whose every argument
 * the reader explains, `classic` one it cannot fully show, `none` not a send it knows: it keeps
 * today's gate. What the card shows of a send is prepared apart from this reading.
 */
export type OutboundCall =
  | { kind: "none" }
  | { kind: "message" }
  | { kind: "classic" }
  | { kind: "refuse"; error: string };

/** The longest a value shows on the card of a send it cannot read, before it is cut and marked. */
export const CARD_VALUE_MAX_LENGTH = 1_000;
const CARD_LINES_MAX_LENGTH = 4_000;
const MAX_ARGUMENT_DEPTH = 32;

type FieldRole =
  | RecipientRole
  | "text"
  | "subject"
  | "sender"
  | "flag"
  | "attachment"
  | "conversation"
  | "toggle"
  | "inert";

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
const CHAT_APPS: ReadonlySet<string> = new Set(["slack"]);

export const REFUSE_UNSHOWABLE: OutboundCall = {
  kind: "refuse",
  error: "Too many arguments to show the user. Send with fewer fields at a time.",
};

type Reading = {
  recipients: AskDraftRecipient[];
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

/** Reads an outgoing call: a mail send, or a send on one of the chat apps. */
export function readOutboundCall(
  action: OutboundAction,
  connectorKinds: string[] = [],
): OutboundCall {
  const words = toolWords(action.toolName);
  const connectorKind = connectorKindFromToolName(action.toolName, connectorKinds);
  const sends = words.some((word) => SEND_VERBS.has(word));
  const chats = CHAT_APPS.has(connectorKind) && words.some((word) => CHAT_VERBS.has(word));
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
  readValue(action.args, undefined, reading, 0);
  const mail =
    sends &&
    (reading.addressed ||
      words.some((word) => word.endsWith("mail")) ||
      isEmailConnectorKind(connectorKind));
  if (!mail) {
    return chats ? readChat(action, reading) : { kind: "none" };
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
  const texts = textLeaves(action.args);
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
  const error = draftTextError(texts[0]!);
  return error ? { kind: "refuse", error } : { kind: "message" };
}

function readChat(action: OutboundAction, reading: Reading): OutboundCall {
  if (reading.tooDeep) {
    return { kind: "refuse", error: "Send this message with simpler arguments." };
  }
  const texts = textLeaves(action.args);
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
  const error = draftTextError(texts[0]!);
  return error ? { kind: "refuse", error } : { kind: "message" };
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
): void {
  if (depth > MAX_ARGUMENT_DEPTH) {
    reading.unexplained = true;
    reading.tooDeep = true;
    return;
  }
  if (role === "flag") {
    if (value != null && value !== false) reading.unexplained = true;
    return;
  }
  // An option that changes nothing the card shows, sent as the bot set it.
  if (role === "toggle") {
    if (typeof value !== "boolean" && value != null) reading.unexplained = true;
    return;
  }
  if (role === "inert" && value && typeof value === "object") {
    reading.unexplained = true;
    return;
  }
  // The card shows a message's text as one string, so a container could hide fields inside it.
  if ((role === "text" || role === "subject") && value && typeof value === "object") {
    reading.unexplained = true;
  }
  if (Array.isArray(value)) {
    for (const item of value) readValue(item, role, reading, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (INHERITED_ROLES.has(role)) {
        readValue(child, role, reading, depth + 1);
        continue;
      }
      const childRole = FIELD_ROLES[fieldKey(key)];
      if (isRecipientRole(childRole)) {
        reading.recipientValues.push(child);
        if (depth > 0) reading.buried = true;
      }
      if (childRole === "conversation" && depth > 0) reading.unexplained = true;
      readValue(child, childRole, reading, depth + 1);
    }
    return;
  }
  if (typeof value === "string" && value.trim()) readString(value, role, reading);
  if ((typeof value === "boolean" || typeof value === "number") && role !== "inert") {
    reading.unexplained = true;
  }
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

function textLeaves(value: unknown, role?: FieldRole): string[] {
  if (role === "flag") return [];
  if (Array.isArray(value)) return value.flatMap((item) => textLeaves(item, role));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      textLeaves(child, INHERITED_ROLES.has(role) ? role : FIELD_ROLES[fieldKey(key)]),
    );
  }
  return role === "text" && typeof value === "string" ? [value] : [];
}

function fieldKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}
