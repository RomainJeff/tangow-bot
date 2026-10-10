import type { MessageBlock } from "@rakazo/contracts";
import {
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH,
  SPAWN_BOT_PROMPT_MAX_LENGTH,
} from "@rakazo/contracts";

/**
 * A bot creating a bot is approved from a card, so what the card shows, what is stored and
 * what gets created must be one value. Every consumer goes through these helpers.
 */
export type SpawnBotArgs = {
  name: string;
  title: string;
  instructions: string;
  prompt: string;
  /** "" (default), "team" or "dedicated" once validated. */
  computerMode: string;
};

const SPAWN_BOT_ARG_KEYS = {
  name: "name",
  title: "title",
  instructions: "instructions",
  prompt: "prompt",
  computerMode: "computer_mode",
} as const;

/** CRLF is just a newline; any other control character is refused by validation. */
function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function textArg(raw: Record<string, unknown>, key: string): string | { error: string } {
  const value = raw[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return { error: `${key} must be a string.` };
  return normalizeText(value);
}

export function normalizeSpawnBotArgs(
  raw: Record<string, unknown>,
): SpawnBotArgs | { error: string } {
  const out: Record<string, string> = {};
  for (const [field, key] of Object.entries(SPAWN_BOT_ARG_KEYS)) {
    const value = textArg(raw, key);
    if (typeof value !== "string") return value;
    out[field] = value;
  }
  return out as SpawnBotArgs;
}

/** The canonical tool arguments: only the fields that carry a value. */
export function spawnBotToolArgs(args: SpawnBotArgs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, key] of Object.entries(SPAWN_BOT_ARG_KEYS)) {
    const value = args[field as keyof SpawnBotArgs];
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The fields a person changed on a Create bot card, compared after normalization: only those
 * fields, or undefined when nothing differs. Web and mobile build `threads/answer` edits with it.
 */
export function spawnBotEdits(
  proposed: { name: string; instructions: string },
  next: { name: string; instructions: string },
): { name?: string; instructions?: string } | undefined {
  const name = normalizeText(next.name);
  const instructions = normalizeText(next.instructions);
  const edits = {
    ...(name !== normalizeText(proposed.name) ? { name } : {}),
    ...(instructions !== normalizeText(proposed.instructions) ? { instructions } : {}),
  };
  return Object.keys(edits).length > 0 ? edits : undefined;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

type SpawnBotDetailFields = Pick<SpawnBotArgs, "title" | "computerMode" | "prompt">;

function spawnBotDetail(
  fields: SpawnBotDetailFields & { instructions?: string },
  withInstructions: boolean,
): string | undefined {
  const lines: string[] = [];
  if (fields.title) lines.push(`Title: ${fields.title}`);
  if (fields.computerMode === "dedicated") lines.push("Computer: Private");
  if (withInstructions && fields.instructions)
    lines.push("Instructions:", indent(fields.instructions));
  if (fields.prompt) lines.push("First message:", indent(fields.prompt));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * What a person cannot change on an editable Create bot card (everything but the name and the
 * instructions), in the same format as the card's detail. Web and mobile render it under the fields.
 */
export function spawnBotReadOnlyDetail(bot: SpawnBotDetailFields): string | undefined {
  return spawnBotDetail(bot, false);
}

/**
 * The Create bot approval card, from the stored request. Never truncated: the fields are bounded
 * by validateSpawnBotArgs, and the user approves exactly what they can read. Multi-line values
 * are indented under their label so a line forged inside the instructions cannot pass for one.
 * The single source for the card the executor shows and the one a reply with edits rewrites.
 */
export function spawnBotApprovalBlock(
  effectId: string,
  args: Record<string, unknown>,
  ownerUserId?: string,
): Extract<MessageBlock, { kind: "ask" }> {
  const normalized = normalizeSpawnBotArgs(args);
  const fields =
    "error" in normalized
      ? { name: "", title: "", instructions: "", prompt: "", computerMode: "" }
      : normalized;
  return {
    kind: "ask",
    approvalEffectId: effectId,
    text: `Create bot “${fields.name || "Untitled"}”?`,
    detail: spawnBotDetail(fields, true),
    status: "pending",
    actions: [
      { id: "allow", label: "Create bot", outcome: "created" },
      { id: "deny", label: "Cancel", outcome: "cancelled" },
    ],
    spawnBot: {
      name: fields.name,
      title: fields.title,
      instructions: fields.instructions,
      prompt: fields.prompt,
      computerMode:
        fields.computerMode === "team" || fields.computerMode === "dedicated"
          ? fields.computerMode
          : "",
      ...(ownerUserId ? { ownerUserId } : {}),
    },
  };
}

/** A card from a server that does not name its owner stays editable; the server still checks. */
export function canEditSpawnBotCard(
  spawnBot: { ownerUserId?: string },
  viewerUserId: string | undefined,
): boolean {
  return !spawnBot.ownerUserId || spawnBot.ownerUserId === viewerUserId;
}

/**
 * Format and joiner controls, variation selectors, tags and line separators hide text from
 * the person reading a card. What stays: the marks that real scripts need (ZWNJ, directional
 * marks, soft hyphen) one at a time, and ZWJ and VS16 only where they build an emoji or a keycap.
 * Default-ignorable code points (Hangul fillers, grapheme joiner…) are refused like format marks.
 */
const HIDDEN_TEXT = new RegExp(
  [
    "(?![\\u200C\\u200D\\u200E\\u200F\\u061C\\u00AD\\uFE0F])[\\p{Cf}\\p{Cs}\\p{Default_Ignorable_Code_Point}\\u2028\\u2029]",
    // The script marks are needed one at a time; a run of them is a hidden channel.
    "[\\u200C\\u200E\\u200F\\u061C\\u00AD]{2,}",
    "[\\uFE00-\\uFE0E]",
    "[\\u{E0100}-\\u{E01EF}]",
    "(?<![\\p{Extended_Pictographic}\\uFE0F\\u{1F3FB}-\\u{1F3FF}])\\u200D",
    "\\u200D(?!\\p{Extended_Pictographic})",
    "(?<![\\p{Extended_Pictographic}0-9#*])\\uFE0F",
    "(?<=[0-9#*])\\uFE0F(?!\\u20E3)",
    // Braille blank renders as an empty cell: a name or a line can end in it unseen.
    "\\u2800",
  ].join("|"),
  "u",
);
const SINGLE_LINE_CONTROLS = /\p{Cc}/u;
const MULTI_LINE_CONTROLS = /(?![\n\t])\p{Cc}/u;

/** True when the text holds characters the person reading the card would not see. */
export function hasHiddenText(text: string, multiLine = false): boolean {
  return (
    HIDDEN_TEXT.test(text) || (multiLine ? MULTI_LINE_CONTROLS : SINGLE_LINE_CONTROLS).test(text)
  );
}

/** False when the text hides characters from a reader, or breaks a line that must stay one. */
export function isVisibleText(value: string, lines: "single" | "multi"): boolean {
  return !hasHiddenText(value, lines === "multi");
}

/** The card renders the name as text; a name shaped like a link or markup could pass for one. */
export const LINK_LIKE_NAME = /[[\]<>]|:\/\/|www\./i;

/** Same bot name, whatever the case, width, spacing or invisible characters. */
export function botNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\p{Cf}|[\uFE00-\uFE0F]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Characters and uniqueness rules shared by spawn_bot and a rename through update_bot. */
export function validateBotNameText(
  name: string,
  existingBotNames: readonly string[],
): string | undefined {
  if (LINK_LIKE_NAME.test(name)) {
    return "name cannot contain [, ], <, > or a web address (://, www.).";
  }
  if (hasHiddenText(name)) {
    return "name must be a single line of visible text, without invisible or control characters.";
  }
  const key = botNameKey(name);
  if (existingBotNames.some((existing) => botNameKey(existing) === key)) {
    return `A bot named "${name}" already exists. Choose a different name.`;
  }
  return undefined;
}

/**
 * Returns the tool error, or undefined when the request may be shown to the user.
 * Lengths come before the character checks so an oversized value is refused without being scanned.
 */
export function validateSpawnBotArgs(
  raw: Record<string, unknown>,
  existingBotNames: readonly string[],
): string | undefined {
  const args = normalizeSpawnBotArgs(raw);
  if ("error" in args) return args.error;
  if (!args.name) return "name is required.";
  if (args.name.length > BOT_NAME_MAX_LENGTH) {
    return `name must be at most ${BOT_NAME_MAX_LENGTH} characters.`;
  }
  if (args.title.length > BOT_TITLE_MAX_LENGTH) {
    return `title must be at most ${BOT_TITLE_MAX_LENGTH} characters.`;
  }
  if (args.instructions.length > SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH) {
    return `instructions must be at most ${SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH} characters.`;
  }
  if (args.prompt.length > SPAWN_BOT_PROMPT_MAX_LENGTH) {
    return `prompt must be at most ${SPAWN_BOT_PROMPT_MAX_LENGTH} characters.`;
  }
  const nameError = validateBotNameText(args.name, existingBotNames);
  if (nameError) return nameError;
  if (hasHiddenText(args.title)) {
    return "title must be a single line of visible text, without invisible or control characters.";
  }
  if (hasHiddenText(args.instructions, true)) {
    return "instructions must not contain invisible or control characters.";
  }
  if (hasHiddenText(args.prompt, true)) {
    return "prompt must not contain invisible or control characters.";
  }
  if (args.computerMode && args.computerMode !== "team" && args.computerMode !== "dedicated") {
    return 'computer_mode must be "team" or "dedicated".';
  }
  return undefined;
}
