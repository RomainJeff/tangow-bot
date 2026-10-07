import type { MessageBlock } from "@rakazo/contracts";
import type { SkillFolderFile } from "@rakazo/core";
import {
  asSkillSaveRequest,
  redactSecrets,
  skillFolderFileBytes,
  spawnBotApprovalBlock,
} from "@rakazo/core";

const MAX_APPROVAL_SUMMARY_LENGTH = 500;
const MAX_APPROVAL_DETAIL_LENGTH = 4_000;

export function buildApprovalAskBlock(
  effectId: string,
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
  options?: { reviewReason?: string; runUserId?: string; mandatory?: boolean },
): MessageBlock {
  // spawn_bot arguments are redacted before they become the effect request, so the card
  // shows exactly what will be created; a second pass would only inflate short secrets.
  if (toolName === "spawn_bot") {
    return spawnBotApprovalBlock(effectId, args, options?.runUserId);
  }
  if (options?.mandatory && Object.hasOwn(CREATION_CARDS, toolName)) {
    const card = CREATION_CARDS[toolName as keyof typeof CREATION_CARDS];
    return {
      kind: "ask",
      approvalEffectId: effectId,
      text: card.title,
      // Bounded before the card (creationCardError): shown whole, never truncated.
      detail: redactSecrets(card.detail(args), secrets),
      status: "pending",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    };
  }
  const summary = describeApprovalAction(toolName, args);
  const detail = formatApprovalDetail(toolName, args, options?.reviewReason);
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
            { id: "always", label: "Always allow this tool" },
            { id: "deny", label: "Deny" },
          ],
  };
}

/** A file's lone CR breaks a line on some screens, so it starts an indented line too. */
function indent(value: string): string {
  return value
    .split(/\r\n?|\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

const SCHEDULE_DETAIL_KEYS = [
  "name",
  "cron",
  "every",
  "unit",
  "runAt",
  "delayMinutes",
  "delaySeconds",
  "timezone",
  "notify",
] as const;

type CreationCard = { title: string; detail: (args: Record<string, unknown>) => string };

/** The name is quoted, so nothing in it can pass for the notes that follow the closing quote. */
function folderFileLabel(file: SkillFolderFile): string {
  return [
    `File: ${JSON.stringify(file.path)}`,
    ...(file.executable ? ["executable"] : []),
    ...("text" in file ? [] : ["binary", `${skillFolderFileBytes(file)} bytes`]),
  ].join(", ");
}

/** A folder lists every file under its own label: text in full, anything else by size. */
const skillCard: CreationCard = {
  title: "Save skill?",
  detail: (args) => {
    const save = asSkillSaveRequest(args);
    if (!save?.files) return String(args.content ?? "");
    return [
      folderFileLabel({ path: "SKILL.md", executable: false, text: save.content }),
      indent(save.content),
      ...save.files.flatMap((file) =>
        "text" in file ? [folderFileLabel(file), indent(file.text)] : [folderFileLabel(file)],
      ),
    ].join("\n");
  },
};

/**
 * Everything a gate card creates. Multi-line values sit indented under their label, so a line
 * forged inside a prompt cannot pass for a field; a skill shows its whole SKILL.md.
 */
const CREATION_CARDS = {
  schedule_create: {
    title: "Create routine?",
    detail: (args) =>
      [
        ...SCHEDULE_DETAIL_KEYS.flatMap((key) =>
          args[key] == null || args[key] === "" ? [] : [`${key}: ${String(args[key])}`],
        ),
        "prompt:",
        indent(String(args.prompt ?? "")),
      ].join("\n"),
  },
  skill_create: skillCard,
  skill_update: skillCard,
} satisfies Record<string, CreationCard>;

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
  for (const key of ["collection", "title", "to", "subject", "amount", "body"]) {
    const value = args[key];
    if (value == null || value === "") continue;
    lines.push(`${key}: ${String(value)}`);
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
