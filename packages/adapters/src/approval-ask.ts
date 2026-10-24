import type { MessageBlock } from "@rakazo/contracts";
import type { RoutineCard } from "@rakazo/core";
import { redactSecrets, routineCardBlock, spawnBotApprovalBlock } from "@rakazo/core";
import type { ConnectorAction } from "./connector-actions.js";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;

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
  const detail = formatApprovalDetail(toolName, args, options?.reviewReason, actions);
  const safeDetail = detail ? redactSecrets(detail, secrets) : undefined;
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
    detail: safeDetail ? truncate(safeDetail, MAX_APPROVAL_DETAIL_LENGTH) : undefined,
    status: "pending",
    actions:
      toolName === "create_space"
        ? [
            { id: "allow", label: "Create space", outcome: "created" },
            { id: "deny", label: "Cancel", outcome: "cancelled" },
          ]
        : [
            { id: "allow", label: "Allow once" },
            // "Always" would allow the batch wrapper, so every future batch, not the action shown.
            ...(actions ? [] : [{ id: "always", label: "Always allow this tool" }]),
            { id: "deny", label: "Deny" },
          ],
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
  actions?: ConnectorAction[],
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
    lines.push(...argLines(actions?.[0]?.args ?? args));
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

const DETAIL_LABELS: Record<string, string> = { recipient_email: "to" };

function argLines(args: Record<string, unknown>): string[] {
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
