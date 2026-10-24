import { connectorKindFromToolName, isEmailConnectorKind } from "./action-approval.js";

/** One tool invocation a connector call performs, in the connector's own naming. */
export type OutboundAction = { toolName: string; args: Record<string, unknown> };

export type OutboundRecipient = { role: "to" | "cc" | "bcc"; address: string };

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
};

/**
 * How a connector call that may send a message is gated. `draft` is a mail whose every
 * argument is explained; `classic` looks like a send the reader cannot fully show; `none` is
 * not a mail send and keeps today's gate.
 */
export type OutboundCall =
  | { kind: "none" }
  | { kind: "draft"; draft: OutboundDraft }
  | { kind: "classic" }
  | { kind: "refuse"; error: string };

const OUTBOUND_DRAFT_MAX_LENGTH = 20_000;
const OUTBOUND_SUBJECT_MAX_LENGTH = 1_000;
/** What the card can show whole: recipients are never cut, so a longer list is refused. */
const OUTBOUND_RECIPIENTS_MAX_LENGTH = 4_000;
// No address is longer, and the address patterns backtrack badly on long input, so every
// pattern runs on a string of at most this length and nowhere else.
const ADDRESS_MAX_LENGTH = 320;

type FieldRole =
  | OutboundRecipient["role"]
  | "text"
  | "subject"
  | "sender"
  | "flag"
  | "attachment"
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
  threadid: "inert",
  messageid: "inert",
  savetosentitems: "inert",
  thought: "inert",
};

const INHERITED_ROLES = new Set<FieldRole | undefined>(["to", "cc", "bcc", "sender", "attachment"]);
const SEND_VERBS = new Set(["send", "sendmail", "sendemail", "reply", "forward"]);
const ADDRESS = /^[^\s@<>"',;:]+@[^\s@<>"',;:]+\.[^\s@<>"',;:]+$/;

function isAddress(value: string): boolean {
  return value.length <= ADDRESS_MAX_LENGTH && ADDRESS.test(value);
}

type Reading = {
  recipients: OutboundRecipient[];
  texts: string[];
  subjects: string[];
  sender?: string;
  addressed: boolean;
  unexplained: boolean;
  /** Length of every recipient-role value as the card prints it, nested ones included. */
  recipientsLength: number;
  /** A recipient sits inside another argument, where the classic card could cut it. */
  buried: boolean;
};

/** Reads a whole connector call: a batch that sends must send alone. */
export function readOutboundCall(
  actions: readonly OutboundAction[],
  connectorKinds: string[] = [],
): OutboundCall {
  const reads = actions.map((action) => readOutbound(action, connectorKinds));
  if (reads.every((read) => read.kind === "none")) return { kind: "none" };
  if (reads.length > 1) return { kind: "refuse", error: "Send this message on its own." };
  return reads[0]!;
}

function readOutbound(action: OutboundAction, connectorKinds: string[]): OutboundCall {
  const words = toolWords(action.toolName);
  if (!words.some((word) => SEND_VERBS.has(word))) return { kind: "none" };
  const reading: Reading = {
    recipients: [],
    texts: [],
    subjects: [],
    addressed: false,
    unexplained: false,
    recipientsLength: 0,
    buried: false,
  };
  const args = readValue(action.args, undefined, reading, 0) as Record<string, unknown>;
  const connectorKind = connectorKindFromToolName(action.toolName, connectorKinds);
  const mail =
    reading.addressed ||
    words.some((word) => word.endsWith("mail")) ||
    isEmailConnectorKind(connectorKind);
  if (!mail) return { kind: "none" };
  if (reading.recipientsLength > OUTBOUND_RECIPIENTS_MAX_LENGTH) {
    return {
      kind: "refuse",
      error: "Too many recipients to show the user. Send to fewer people at a time.",
    };
  }
  const [body] = reading.texts;
  if (
    words.includes("forward") ||
    reading.unexplained ||
    body === undefined ||
    reading.texts.length > 1 ||
    reading.subjects.length > 1 ||
    reading.subjects.some((subject) => subject.length > OUTBOUND_SUBJECT_MAX_LENGTH) ||
    body.length > OUTBOUND_DRAFT_MAX_LENGTH ||
    !reading.recipients.some((recipient) => recipient.role === "to")
  ) {
    return reading.buried
      ? { kind: "refuse", error: "Put the recipients in the to, cc and bcc arguments." }
      : { kind: "classic" };
  }
  return {
    kind: "draft",
    draft: {
      connectorKind,
      recipients: reading.recipients,
      subject: reading.subjects[0],
      body,
      account: reading.sender,
      args,
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
  if (role === "flag") {
    if (typeof value === "boolean") return false;
    if (value != null) reading.unexplained = true;
    return value;
  }
  if (role === "inert" && value && typeof value === "object") {
    reading.unexplained = true;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => readValue(item, role, reading, depth));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        if (INHERITED_ROLES.has(role)) return [key, readValue(child, role, reading, depth + 1)];
        const childRole = FIELD_ROLES[fieldKey(key)];
        if (childRole === "to" || childRole === "cc" || childRole === "bcc") {
          reading.recipientsLength += (JSON.stringify(child) ?? "").length;
          if (depth > 0) reading.buried = true;
        }
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
    case "bcc":
      reading.addressed ||= value.includes("@");
      if (isAddress(value.trim())) reading.recipients.push({ role, address: value.trim() });
      else reading.unexplained = true;
      return;
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
      if (!isAddress(sender) || (first && first.toLowerCase() !== sender.toLowerCase())) {
        reading.unexplained = true;
      } else reading.sender ??= sender;
      return;
    }
    case "inert":
      return;
    default:
      reading.unexplained = true;
  }
}

/** Whether an argument name carries recipients, so a card never shortens it. */
export function isRecipientField(key: string): boolean {
  const role = FIELD_ROLES[fieldKey(key)];
  return role === "to" || role === "cc" || role === "bcc";
}

function fieldKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}
