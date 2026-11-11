import type { AgentRuntimeEvent } from "@tangow/adapter-kit";
import type { AskQuestion } from "@tangow/contracts";

// C0 and C1 controls (whitespace aside, collapsed below), bidi marks and overrides, and zero-width
// characters. U+200D stays: it joins emoji.
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters removed
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** Model text a card shows as plain text: visible characters on one line, NFC, at most `max` code points. */
function cardText(value: unknown, max = Number.POSITIVE_INFINITY, keepLines = false): string {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(INVISIBLE, "");
  // A question is Markdown, so its line breaks carry lists and paragraphs: fold spaces per line only.
  const folded = keepLines
    ? cleaned
        .split(/\r?\n/)
        .map((line) => {
          const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
          return indent + line.slice(indent.length).replace(/\s+/g, " ").trim();
        })
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
    : cleaned.replace(/\s+/g, " ");
  const text = folded.trim().normalize("NFC");
  return Array.from(text).slice(0, max).join("").trimEnd();
}

type AskOptionInput = { label: string; description?: string; recommended?: true };

function askOption(raw: unknown): AskOptionInput {
  if (typeof raw === "string") return { label: cardText(raw) };
  const option = (raw ?? {}) as Record<string, unknown>;
  const label = cardText(option.label);
  if (!label) {
    throw new Error('each ask_user option is a string or an object with a non-empty "label"');
  }
  const description = cardText(option.description, 80);
  return {
    label,
    ...(description ? { description } : {}),
    ...(option.recommended === true ? { recommended: true } : {}),
  };
}

/**
 * Normalize the ask_user v2 `questions` argument into validated AskQuestion[] with stable ids.
 * Returns null when no `questions` array is present (caller falls back to the legacy single
 * question + options shape). Throws on a malformed questions array so the model sees the error.
 */
export function normalizeAskQuestions(raw: Record<string, unknown>): AskQuestion[] | null {
  if (!Array.isArray(raw.questions)) return null;
  const rawQuestions = raw.questions;
  if (rawQuestions.length < 1 || rawQuestions.length > 4) {
    throw new Error("ask_user accepts one to four questions");
  }
  return rawQuestions.map((entry, qIndex) => {
    const q = (entry ?? {}) as Record<string, unknown>;
    const question = cardText(q.question, 240, true);
    if (!question) throw new Error("each ask_user question needs non-empty question text");
    const options = Array.isArray(q.options) ? q.options.map(askOption) : [];
    const labels = options.map((option) => option.label);
    if (
      options.length > 0 &&
      (options.length < 2 ||
        options.length > 4 ||
        labels.some((label) => label.length === 0 || label.length > 80) ||
        new Set(labels).size !== labels.length)
    ) {
      throw new Error(
        "each ask_user question offers two to four unique, non-empty options (or none for a free-text answer)",
      );
    }
    const recommended = options.findIndex((option) => option.recommended);
    const header = cardText(q.header, 24);
    return {
      id: `q${qIndex + 1}`,
      ...(header ? { header } : {}),
      question,
      ...(options.length
        ? {
            options: options.map(({ recommended: _, ...option }, oIndex) => ({
              id: `q${qIndex + 1}o${oIndex + 1}`,
              ...option,
              ...(oIndex === recommended ? { recommended: true } : {}),
            })),
          }
        : {}),
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
      ...(q.required === false ? { required: false } : {}),
    };
  });
}

/** The card an ask_user call shows, and what the model reads while the run waits on it. */
export function askUserCard(args: Record<string, unknown>): {
  card: Extract<AgentRuntimeEvent, { type: "ask" }>;
  reply: string;
} {
  const questions = normalizeAskQuestions(args);
  if (questions) {
    return {
      card: {
        type: "ask",
        // Push notifications and TTS read this text, so a multi-question card still
        // needs a non-empty body: list every question rather than sending nothing.
        text: questions.map((entry) => entry.question).join("\n"),
        questions,
      },
      reply: "Waiting for the user's answers.",
    };
  }
  if (Array.isArray(args.options) && args.options.some((option) => typeof option !== "string")) {
    throw new Error(
      "ask_user's top-level options are plain strings; give an option a description or a recommended mark inside questions[].options",
    );
  }
  const options = Array.isArray(args.options) ? args.options.map((option) => cardText(option)) : [];
  if (
    options.length < 2 ||
    options.length > 4 ||
    options.some((option) => option.length === 0 || option.length > 80) ||
    new Set(options).size !== options.length
  ) {
    throw new Error("ask_user requires two to four unique, non-empty options");
  }
  return {
    card: {
      type: "ask",
      text: String(args.question ?? "What should I use?"),
      actions: options.map((label, index) => ({ id: `choice-${index + 1}`, label })),
    },
    reply: "Waiting for the user's choice.",
  };
}
