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

function textArg(raw: Record<string, unknown>, key: string): string | { error: string } {
  const value = raw[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return { error: `${key} must be a string.` };
  // CRLF is just a newline; any other control character is refused by validation.
  return value.replace(/\r\n/g, "\n").trim();
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
 * Format and joiner controls, variation selectors, tags and line separators hide text from
 * the person reading a card. What stays: the marks that real scripts need (ZWNJ, directional
 * marks, soft hyphen) one at a time, and ZWJ and VS16 only where they build an emoji or a keycap.
 * Default-ignorable code points (Hangul fillers, grapheme joiner…) are refused like format marks.
 */
const HIDDEN_TEXT = new RegExp(
  [
    "(?![\\u200C\\u200D\\u200E\\u200F\\u061C\\u00AD\\uFE0F])[\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u2028\\u2029]",
    // The script marks are needed one at a time; a run of them is a hidden channel.
    "[\\u200C\\u200E\\u200F\\u061C\\u00AD]{2,}",
    "[\\uFE00-\\uFE0E]",
    "[\\u{E0100}-\\u{E01EF}]",
    "(?<![\\p{Extended_Pictographic}\\uFE0F\\u{1F3FB}-\\u{1F3FF}])\\u200D",
    "\\u200D(?!\\p{Extended_Pictographic})",
    "(?<![\\p{Extended_Pictographic}0-9#*])\\uFE0F",
  ].join("|"),
  "u",
);
const SINGLE_LINE_CONTROLS = /\p{Cc}/u;
const MULTI_LINE_CONTROLS = /(?![\n\t])\p{Cc}/u;

/** The card renders the name as text; a name shaped like a link or markup could pass for one. */
const LINK_LIKE_NAME = /[[\]<>]|:\/\/|www\./i;

/** Same bot name, whatever the case, width, spacing or invisible characters. */
export function botNameKey(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Characters and uniqueness rules shared by spawn_bot and a rename through update_bot. */
export function validateBotNameText(
  name: string,
  existingBotNames: readonly string[],
): string | undefined {
  if (HIDDEN_TEXT.test(name) || SINGLE_LINE_CONTROLS.test(name)) {
    return "name must be a single line of visible text, without invisible or control characters.";
  }
  const key = botNameKey(name);
  if (existingBotNames.some((existing) => botNameKey(existing) === key)) {
    return `A bot named "${name}" already exists. Choose a different name.`;
  }
  return undefined;
}

/** Returns the tool error, or undefined when the request may be shown to the user. */
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
  if (LINK_LIKE_NAME.test(args.name)) {
    return "name cannot contain [, ], <, > or a web address (://, www.).";
  }
  const nameError = validateBotNameText(args.name, existingBotNames);
  if (nameError) return nameError;
  if (args.title.length > BOT_TITLE_MAX_LENGTH) {
    return `title must be at most ${BOT_TITLE_MAX_LENGTH} characters.`;
  }
  if (HIDDEN_TEXT.test(args.title) || SINGLE_LINE_CONTROLS.test(args.title)) {
    return "title must be a single line of visible text, without invisible or control characters.";
  }
  if (HIDDEN_TEXT.test(args.instructions) || MULTI_LINE_CONTROLS.test(args.instructions)) {
    return "instructions must not contain invisible or control characters.";
  }
  if (HIDDEN_TEXT.test(args.prompt) || MULTI_LINE_CONTROLS.test(args.prompt)) {
    return "prompt must not contain invisible or control characters.";
  }
  if (args.instructions.length > SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH) {
    return `instructions must be at most ${SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH} characters.`;
  }
  if (args.prompt.length > SPAWN_BOT_PROMPT_MAX_LENGTH) {
    return `prompt must be at most ${SPAWN_BOT_PROMPT_MAX_LENGTH} characters.`;
  }
  if (args.computerMode && args.computerMode !== "team" && args.computerMode !== "dedicated") {
    return 'computer_mode must be "team" or "dedicated".';
  }
  return undefined;
}
