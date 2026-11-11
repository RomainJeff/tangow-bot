import type { AskDraft, MessageBlock } from "@tangow/contracts";
import type { RoutineCard } from "@tangow/core";
import {
  askDraftDetail,
  CARD_VALUE_MAX_LENGTH,
  draftSentLine,
  draftSentTo,
  isWholeField,
  LINE_BREAKS,
  redactSecrets,
  routineCardBlock,
  spawnBotApprovalBlock,
} from "@tangow/core";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;
const LONG_APPROVAL_VALUE_LENGTH = 500;

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/**
 * What the push for an approval says: a draft names its app, its subject (or first line) and its
 * recipient, any other approval the card's own summary. Built from the redacted card only.
 */
export function approvalPushBody(block: AskBlock): string {
  const { draft } = block;
  if (!draft) return block.text;
  const line = draftSentLine(draft);
  return `${draft.app.name}: ${line ? `${line} ` : ""}to ${draftSentTo(draft)}`;
}

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
    /** The run owner's name, shown as the sender of a draft. */
    runUserName?: string;
    /** A mail to send: shown in full, sent or discarded, no "always". */
    draft?: AskDraft;
    /** A possible send the card cannot read field by field: every argument shows, no "always". */
    unreadable?: boolean;
  },
): AskBlock {
  // spawn_bot and schedule_create arguments are redacted before they become the effect request,
  // so the card shows exactly what will be created; a second pass would only inflate short secrets.
  if (toolName === "spawn_bot") return spawnBotApprovalBlock(effectId, args, options?.runUserId);
  if (options?.routineCard) return routineCardBlock(effectId, options.routineCard);
  const summary = describeApprovalAction(toolName, args);
  const owner = options?.runUserId
    ? {
        userId: options.runUserId,
        ...(options.runUserName ? { name: options.runUserName } : {}),
      }
    : undefined;
  const draft = options?.draft && {
    ...redactDraft(options.draft, secrets),
    ...(owner ? { owner } : {}),
  };
  const detail = formatApprovalDetail(toolName, args, options?.reviewReason, options?.unreadable);
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
  // An unreadable send shows every argument, so its size is bounded by the gate instead.
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
    detail: draft ? askDraftDetail(draft) : shownDetail,
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
            ...(options?.unreadable ? [] : [{ id: "always", label: "Always allow this tool" }]),
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
  lines.push(...argLines(args, everyArgument));
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

const DETAIL_LABELS: Record<string, string> = { recipient_email: "to" };

function argLines(args: Record<string, unknown>, everyArgument = false): string[] {
  if (everyArgument) {
    // Every argument shows. Whole fields (recipients) come first, long values last and cut with
    // a mark; the caller refuses a send whose arguments cannot fit.
    const values = Object.entries(args).map(([key, value]) => ({
      key,
      text: typeof value === "string" ? value : JSON.stringify(value),
      whole: isWholeField(key),
    }));
    const isLong = ({ text, whole }: { text: string; whole: boolean }) =>
      !whole && text.length > LONG_APPROVAL_VALUE_LENGTH;
    const rest = values.filter(({ whole }) => !whole);
    return [
      ...values.filter(({ whole }) => whole),
      ...rest.filter((entry) => !isLong(entry)),
      ...rest.filter(isLong),
    ].map(({ key, text, whole }) => {
      const shown = whole ? text : truncate(text, CARD_VALUE_MAX_LENGTH);
      return `${key.replace(LINE_BREAKS, " ")}: ${shown.replace(LINE_BREAKS, "\n  ")}`;
    });
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
