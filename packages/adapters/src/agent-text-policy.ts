import type { AgentRunRequest, HarnessTranscriptEntry } from "@rakazo/adapter-kit";
import { TOOL_FINAL_RESPONSE_FALLBACK } from "./user-progress.js";

// Some OpenAI-compatible models return EOS immediately after a tool result
// instead of taking another assistant turn. A bounded internal follow-up keeps
// that provider quirk from making a long task look complete after one step.
const MAX_SILENT_TOOL_CONTINUATIONS = 3;
const SILENT_TOOL_CONTINUATION_PROMPT =
  "Continue the original task from the latest tool result. Do not stop after a tool call; use any remaining tools needed, then deliver the result.";
const SILENCE_ALLOWED_CONTINUATION_PROMPT =
  "Continue the original task from the latest tool result. Use any remaining tools needed, then deliver the result, or end with no reply if there is nothing to report.";
const PRIVATE_TEXT_PROMPT =
  "Nothing you wrote reached the user: only message_user does. If that text was meant for them, send it with message_user now. Otherwise end the turn.";
// A long task the user only follows through message_user looks frozen when the model works
// for many steps without reporting, so it is reminded to check in.
const CHECK_IN_AFTER_TOOL_CALLS = 30;
const USER_CONTACT_TOOLS = new Set([
  "message_user",
  "ask_user",
  "request_secret",
  "request_takeover",
]);
const checkInPrompt = (toolCalls: number) =>
  `Harness note, not from the user: you have made ${toolCalls} tool calls since the user last heard from you. Send them a short progress update with message_user (what you found, what is next), then continue.`;

type TextPolicyOptions = Pick<
  AgentRunRequest,
  "allowSilentEmpty" | "freeTextIsPrivate" | "runRecap" | "emptyResponseText"
>;

export function createAgentTextPolicy(options: TextPolicyOptions) {
  let privateFinalText: string | undefined;
  let silentToolContinuations = 0;
  let toolWorkPendingFinal = false;
  const emptyFinalMayBeSilence = options.allowSilentEmpty && !options.freeTextIsPrivate;
  let messagedUser = false;
  let privateTextNudged = false;
  let toolCallsSinceContact = 0;
  return {
    turn({
      messageText,
      toolCallNames,
      hasToolResults,
      paused,
    }: {
      messageText: string;
      toolCallNames: string[];
      hasToolResults: boolean;
      paused: boolean;
    }) {
      const followUp: string[] = [];
      const steer: string[] = [];
      const hasToolCalls = toolCallNames.length > 0;
      if (options.runRecap) privateFinalText = hasToolCalls ? undefined : messageText;

      // An update sent before more tool work did not deliver what that work found.
      if (hasToolCalls) messagedUser = toolCallNames.includes("message_user");
      if (options.freeTextIsPrivate) {
        toolCallsSinceContact = toolCallNames.some((name) => USER_CONTACT_TOOLS.has(name))
          ? 0
          : toolCallsSinceContact + toolCallNames.length;
        if (toolCallsSinceContact >= CHECK_IN_AFTER_TOOL_CALLS && !paused) {
          steer.push(checkInPrompt(toolCallsSinceContact));
          toolCallsSinceContact = 0;
        }
      }
      if (
        options.freeTextIsPrivate &&
        !hasToolCalls &&
        messageText.trim() &&
        !messagedUser &&
        !privateTextNudged &&
        !paused
      ) {
        privateTextNudged = true;
        followUp.push(PRIVATE_TEXT_PROMPT);
      }

      // Text in a turn that also contains a tool call is narration, not a final
      // response. Keep the run alive until a later text-only turn answers the user,
      // or a turn that only messages the user, which already delivered the answer.
      if (toolCallNames.length > 0 && toolCallNames.every((name) => name === "message_user")) {
        toolWorkPendingFinal = false;
        silentToolContinuations = 0;
      } else if (hasToolCalls && hasToolResults && !paused) {
        toolWorkPendingFinal = true;
        silentToolContinuations = 0;
      } else if (toolWorkPendingFinal && !hasToolCalls && !hasToolResults) {
        if (messageText.trim() || (emptyFinalMayBeSilence && silentToolContinuations > 0)) {
          toolWorkPendingFinal = false;
          silentToolContinuations = 0;
        } else if (!paused && silentToolContinuations < MAX_SILENT_TOOL_CONTINUATIONS) {
          silentToolContinuations += 1;
          followUp.push(
            emptyFinalMayBeSilence
              ? SILENCE_ALLOWED_CONTINUATION_PROMPT
              : SILENT_TOOL_CONTINUATION_PROMPT,
          );
        }
      }
      return { followUp, steer };
    },
    finish({
      streamed,
      fallback,
      toolCalls,
      paused,
    }: {
      streamed: string;
      fallback: string;
      toolCalls: number;
      paused: boolean;
    }) {
      let text = streamed;
      let runtimeNotice: string | undefined;
      if (!paused && toolWorkPendingFinal) {
        text = TOOL_FINAL_RESPONSE_FALLBACK;
        runtimeNotice = text;
      } else if (!text.trim() && !paused) {
        text = "";
        if (fallback.trim()) text = fallback;
        else if (toolCalls === 0 && !options.allowSilentEmpty)
          text = options.emptyResponseText?.trim() || "No response. Try again.";
      }
      return {
        text,
        ...(options.runRecap ? { privateFinalText: privateFinalText ?? "" } : {}),
        ...(runtimeNotice ? { runtimeNotice } : {}),
      };
    },
  };
}

export function nativeTranscriptText(
  entries: readonly HarnessTranscriptEntry[],
  options: TextPolicyOptions,
) {
  const policy = createAgentTextPolicy(options);
  let turn: number | undefined;
  let messageText = "";
  let toolCallNames: string[] = [];
  let streamed = "";
  let toolCalls = 0;
  const flush = () => {
    if (turn === undefined) return;
    policy.turn({
      messageText: stripModelControlTokens(messageText),
      toolCallNames,
      hasToolResults: toolCallNames.length > 0,
      paused: false,
    });
    if (toolCallNames.length > 0) streamed = "";
    else streamed += stripModelControlTokens(messageText);
  };
  for (const entry of entries) {
    if (entry.kind === "summary" || entry.kind === "result") continue;
    if (turn !== entry.turn) {
      flush();
      turn = entry.turn;
      messageText = "";
      toolCallNames = [];
    }
    if (entry.kind === "text") messageText += entry.text;
    else {
      toolCallNames.push(entry.name);
      toolCalls += 1;
    }
  }
  flush();
  return policy.finish({
    streamed,
    fallback: stripModelControlTokens(messageText),
    toolCalls,
    paused: false,
  });
}

const FAKE_TOOL_CALL_START = /\[tool \w+\(/g;
const FAKE_TOOL_CALL_ONLY = "(earlier reply omitted: it was malformed)";

/**
 * Replies stored before tool calls were replayed as real turns can contain the
 * old `[tool name(args) → output]` trace written as text. Replayed as-is they
 * teach the model to keep writing calls instead of making them, so each span is
 * cut, bracket-balanced and JSON-string aware; an unclosed span runs to the end.
 */
export function stripFakeToolCalls(content: string): string {
  let result = "";
  let cursor = 0;
  let stripped = false;
  for (const match of content.matchAll(FAKE_TOOL_CALL_START)) {
    if (match.index < cursor) continue;
    let end = content.length;
    let depth = 0;
    let inString = false;
    for (let i = match.index; i < content.length; i += 1) {
      const char = content[i];
      if (inString) {
        if (char === "\\") i += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "[" || char === "(" || char === "{") depth += 1;
      else if (char === "]" || char === ")" || char === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    result += content.slice(cursor, match.index);
    cursor = end;
    stripped = true;
  }
  if (!stripped) return content;
  const cleaned = (result + content.slice(cursor)).replace(/\n{3,}/g, "\n\n").trim();
  return cleaned || FAKE_TOOL_CALL_ONLY;
}

export function stripModelControlTokens(text: string): string {
  if (!text.includes("<|")) return text;
  return text.replace(/<\|[^\s|>]{1,64}\|>/g, "");
}
