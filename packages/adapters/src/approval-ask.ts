import type { AskDraft, MessageBlock } from "@rakazo/contracts";
import type { RoutineCard } from "@rakazo/core";
import {
  isRecipientField,
  redactSecrets,
  routineCardBlock,
  spawnBotApprovalBlock,
} from "@rakazo/core";
import type { ConnectorAction } from "./connector-actions.js";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
const MAX_APPROVAL_VALUE_LENGTH = 1_000;
const LONG_APPROVAL_VALUE_LENGTH = 500;
// Continuation lines are indented so a line written inside a value cannot pass for a field.
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g;

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: {
    reviewReason?: string;
    /** A routine proposal card, as resolved before it shows. */
    routineCard?: RoutineCard;
    runUserId?: string;
    /** What a batch call runs: the card shows these instead of the wrapper. */
    actions?: ConnectorAction[];
    /** A mail to send: shown in full, sent or discarded, no "always". */
    draft?: AskDraft;
    /** A possible send the card cannot read field by field: every argument shows, no "always". */
    unreadable?: boolean;
  },
): MessageBlock {
  // spawn_bot and schedule_create arguments are redacted before they become the effect request,
  // so the card shows exactly what will be created; a second pass would only inflate short secrets.
  if (toolName === "spawn_bot") return spawnBotApprovalBlock(effectId, args, options?.runUserId);
  if (options?.routineCard) return routineCardBlock(effectId, options.routineCard);
  const actions = options?.actions;
  const summary = actions
    ? actions.map((action) => describeApprovalAction(action.toolName, action.args)).join(", ")
    : describeApprovalAction(toolName, args);
  const draft = options?.draft && redactDraft(options.draft, secrets);
  const detail = formatApprovalDetail(
    toolName,
    args,
    options?.reviewReason,
    actions,
    options?.unreadable,
  );
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  // An unreadable send keeps its recipients whole and bounds the rest itself.
  const shownDetail =
    safeDetail && !options?.unreadable
      ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH)
      : safeDetail;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: truncate(
      redactSecrets(
        toolName === "create_space" ? `${summary}?` : `Review before ${summary}`,
        secrets,
      ),
      MAX_APPROVAL_SUMMARY_LENGTH,
    ),
    detail: draft ? draftDetail(draft) : shownDetail,
    status: "pending",
    actions: draft
      ? [
          { id: "allow", label: "Send" },
          { id: "deny", label: "Discard" },
        ]
      : toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            // "Always" would allow the batch wrapper, so every future batch, not the action shown.
            ...(actions || options?.unreadable
              ? []
              : [{ id: "always", label: "Always allow this tool" }]),
            { id: "deny", label: "Deny" },
          ],
    ...(draft ? { draft } : {}),
  };
}

function redactDraft(draft: AskDraft, secrets: string[]): AskDraft {
  return {
    ...draft,
    subject: draft.subject === undefined ? undefined : redactSecrets(draft.subject, secrets),
    body: redactSecrets(draft.body, secrets),
  };
}

function draftDetail(draft: AskDraft): string {
  const lines = (["to", "cc", "bcc"] as const).flatMap((role) => {
    const addresses = draft.recipients.filter((recipient) => recipient.role === role);
    return addresses.length
      ? [`${role}: ${addresses.map((recipient) => recipient.address).join(", ")}`]
      : [];
  });
  // Continuation lines are indented so a line written inside the mail cannot pass for a header.
  if (draft.subject) lines.push(`subject: ${draft.subject.replaceAll("\n", "\n  ")}`);
  lines.push("body:", `  ${draft.body.replaceAll("\n", "\n  ")}`);
  return lines.join("\n");
}

function describeApprovalAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "destination.write") {
    const collection = args.collection ? String(args.collection) : "records";
    const title = args.title ? ` "${String(args.title)}"` : "";
    return `writing${title} to ${collection}`;
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  if (toolName === "create_space") {
    const name = args.name ? String(args.name) : "Untitled";
    return `Create space “${name}”`;
  }
  const target = pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  toolName: string,
  args: Record<string, unknown>,
  reviewReason?: string,
  actions?: ConnectorAction[],
  everyArgument = false,
): string | undefined {
  const lines: string[] = [];
  if (reviewReason?.trim()) {
    lines.push(reviewReason.trim().replace(/\u2014|\u2013/g, "-"));
  }
  if (toolName === "create_space") {
    lines.push(
      "Bots, groups, chats, files, memory, and integrations in this space stay separate from other spaces.",
    );
  }
  if (actions && actions.length > 1) {
    for (const action of actions) {
      lines.push(action.toolName, ...argLines(action.args).map((line) => `  ${line}`));
    }
  } else {
    lines.push(...argLines(actions?.[0]?.args ?? args, everyArgument));
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

const DETAIL_LABELS: Record<string, string> = { recipient_email: "to" };

function argLines(args: Record<string, unknown>, everyArgument = false): string[] {
  if (everyArgument) {
    // Recipients come first and whole: a send with more than the card can show is refused
    // upstream. The rest shares one budget, so cutting it never hides a recipient or a flag.
    const values = Object.entries(args).map(([key, value]) => ({
      key,
      text: typeof value === "string" ? value : JSON.stringify(value),
      recipient: isRecipientField(key),
    }));
    const isLong = ({ text, recipient }: { text: string; recipient: boolean }) =>
      !recipient && text.length > LONG_APPROVAL_VALUE_LENGTH;
    const rest = values.filter(({ recipient }) => !recipient);
    let budget = MAX_APPROVAL_DETAIL_LENGTH;
    const shown = [
      ...values.filter(({ recipient }) => recipient),
      ...rest.filter((entry) => !isLong(entry)),
      ...rest.filter(isLong),
    ].flatMap(({ key, text, recipient }) => {
      if (recipient) return [{ key, text }];
      const room = budget - key.length - 3;
      if (room <= 0) return [];
      const kept = truncate(text, Math.min(MAX_APPROVAL_VALUE_LENGTH, room));
      budget -= key.length + 3 + kept.length;
      return [{ key, text: kept }];
    });
    return shown.map(
      ({ key, text }) => `${key.replace(LINE_BREAKS, " ")}: ${text.replace(LINE_BREAKS, "\n  ")}`,
    );
  }
  const lines: string[] = [];
  for (const key of ["collection", "title", "to", "recipient_email", "subject", "amount", "body"]) {
    const value = args[key];
    if (value == null || value === "") continue;
    lines.push(`${DETAIL_LABELS[key] ?? key}: ${String(value)}`);
  }
  return lines;
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "recipient_email", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
