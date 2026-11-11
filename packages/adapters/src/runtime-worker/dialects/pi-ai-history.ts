import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { AgentRunRequest, HarnessTranscriptEntry } from "@tangow/adapter-kit";
import * as z from "zod";
import { stripFakeToolCalls } from "../../agent-text-policy.js";

/**
 * Canonical history and a native Pi session, both ways. The controller owns the canonical
 * history: a guest projects it into the session it runs, and the controller ingests what the
 * attempt added to that session.
 */

const ASSISTANT_TURN_OPEN = "<assistant_turn>";
const ASSISTANT_TURN_CLOSE = "</assistant_turn>";

/**
 * Stored text can contain anything, including our own turn delimiter, so a user
 * (or a peer quoting one) could otherwise write a line the flattening cannot
 * tell from a real assistant turn. Escape it the way prompt data is escaped
 * elsewhere; only the wrapper below emits the literal tag.
 */
function sealAssistantTurnMarkers(content: string): string {
  return content
    .replaceAll(ASSISTANT_TURN_OPEN, "&lt;assistant_turn&gt;")
    .replaceAll(ASSISTANT_TURN_CLOSE, "&lt;/assistant_turn&gt;");
}

/**
 * What a rehydrated turn reports it cost: nothing. Those tokens were billed on
 * the run that produced the turn, so replaying it must not reach a counter twice.
 */
function noUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Replayed turns are stamped with a model id no provider uses, so pi-ai always treats them as
 * foreign: it rewrites stored tool-call ids into the current provider's format (the thread may
 * have switched model since) and never pairs them with reasoning items we did not keep.
 */
const REPLAYED_HISTORY_MODEL = "tangow-replayed-history";
const NO_TOOL_OUTPUT = "(no output recorded)";

/**
 * Rehydrate a thread into the messages this runtime sends.
 *
 * The bot's own past turns come back as `assistant` messages: the shape models
 * are trained on, and structure a peer cannot forge from text. When a turn ran
 * tools with a stored call id, those calls come back as real tool calls, each
 * followed by its result, so the model sees how it called tools instead of a
 * text trace it could learn to imitate. User turns and peer turns stay on the
 * user side, peers keeping the `<bot_message from=…>` block the wake prompt
 * already delivers them in.
 *
 * The oldest kept turn is the exception: a provider can refuse a request whose
 * first message is an assistant turn, so that one falls back to the marked user
 * rendering (tool calls as prose) instead of being dropped.
 */
export function toHistory(
  history: AgentRunRequest["history"],
  prompt: string,
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  sourceMessageId?: string | null,
): AgentMessage[] {
  let duplicatePromptIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (
      message?.role === "user" &&
      (sourceMessageId ? message.id === sourceMessageId : message.content === prompt)
    ) {
      duplicatePromptIndex = index;
      break;
    }
  }
  const prior =
    duplicatePromptIndex < 0
      ? history
      : history.filter((_, index) => index !== duplicatePromptIndex);
  const usedToolCallIds = new Set<string>();
  // Ids must be unique across the whole request: pi-ai maps results to calls by id.
  const uniqueToolCallId = (id: string) => {
    let unique = id;
    for (let n = 2; usedToolCallIds.has(unique); n += 1) unique = `h${n}_${id}`;
    usedToolCallIds.add(unique);
    return unique;
  };
  return prior.flatMap((m, index): AgentMessage[] => {
    const timestamp = Date.now();
    const assistant = (
      content: AssistantMessage["content"],
      stopReason: AssistantMessage["stopReason"],
    ): AssistantMessage => ({
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: REPLAYED_HISTORY_MODEL,
      usage: noUsage(),
      stopReason,
      timestamp,
    });
    if (m.role === "assistant" && index > 0 && m.parts) {
      const messages: AgentMessage[] = [];
      let text: AssistantMessage["content"] = [];
      for (const part of m.parts) {
        if (part.type === "text") {
          text.push({
            type: "text",
            text: sealAssistantTurnMarkers(stripFakeToolCalls(part.text)),
          });
          continue;
        }
        const calls = part.calls.map((call) => ({ ...call, id: uniqueToolCallId(call.id) }));
        const toolCalls: ToolCall[] = calls.map((call) => ({
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: z.record(z.string(), z.json()).parse(call.args),
        }));
        messages.push(assistant([...text, ...toolCalls], "toolUse"));
        text = [];
        // Every call gets its result, also when none was recorded (the run stopped or failed
        // mid-tool): a call without a result is refused by most providers.
        for (const call of calls) {
          messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: call.output || NO_TOOL_OUTPUT }],
            isError: false,
            timestamp,
          });
        }
      }
      if (text.length > 0) messages.push(assistant(text, "stop"));
      return messages;
    }
    const content = sealAssistantTurnMarkers(
      m.role === "assistant" ? stripFakeToolCalls(m.content) : m.content,
    );
    if (m.role === "assistant" && index > 0) {
      return [assistant([{ type: "text", text: content }], "stop")];
    }
    return [
      {
        role: "user",
        content:
          m.role === "assistant"
            ? `${ASSISTANT_TURN_OPEN}\n${content}\n${ASSISTANT_TURN_CLOSE}`
            : content,
        timestamp,
      },
    ];
  });
}

/** Canonical names stay intact here; the guest maps them to Pi's actual assigned names. */
export function projectPiAi(
  history: AgentRunRequest["history"],
  prompt: string,
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  sourceMessageId?: string | null,
): Message[] {
  return toHistory(history, prompt, model, sourceMessageId) as Message[];
}

export interface IngestResult {
  steps: HarnessTranscriptEntry[];
  /** Results claimed for other tools' calls beyond what the controller answered. */
  unverifiedCalls: number;
}

export interface IngestOptions {
  /** How many calls of each controller tool the controller answered so far. */
  answered: ReadonlyMap<string, number>;
  /** The tools the harness runs itself, from its manifest. Only these are ever its own. */
  nativeTools: readonly string[];
  /** Redacts and bounds every string kept from the transcript. */
  clean: (text: string) => string;
}

const Block = z.looseObject({ type: z.string() });
const Content = z.union([z.string(), z.array(Block)]);
const TextBlock = z.object({ type: z.literal("text"), text: z.string() });
const ToolCallBlock = z.object({
  type: z.literal("toolCall"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
});
const TranscriptMessage = z.discriminatedUnion("role", [
  z.looseObject({ role: z.literal("assistant"), content: z.array(Block) }),
  z.looseObject({
    role: z.literal("toolResult"),
    toolCallId: z.string(),
    content: Content,
    isError: z.boolean().optional(),
  }),
  z.looseObject({
    role: z.literal("compactionSummary"),
    summary: z.string(),
    tokensBefore: z.number().int().nonnegative(),
  }),
]);

function textOf(content: z.infer<typeof Content>): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      const text = TextBlock.safeParse(block);
      return text.success ? text.data.text : "";
    })
    .join("");
}

/**
 * Ingests one agent's native session as it reports it: each call returns the steps of the messages
 * it is given, in order. A message or block canonical history has no place for, such as the
 * user's or the harness's thinking, is left out. Only a tool of the harness's manifest is its own:
 * a result the harness reports for any other call answers nothing, and one beyond what the
 * controller answered is counted, whatever its name. Controller names are already canonical at the
 * guest boundary and must not be treated as aliases.
 */
export function ingestPiAi({ answered, nativeTools, clean }: IngestOptions) {
  const native = new Set(nativeTools);
  const open = new Map<string, { own: boolean; name: string }>();
  const claimed = new Map<string, number>();
  let turn = 0;
  return (messages: readonly unknown[]): IngestResult => {
    const steps: HarnessTranscriptEntry[] = [];
    let unverifiedCalls = 0;
    for (const raw of messages) {
      const parsed = TranscriptMessage.safeParse(raw);
      if (!parsed.success) continue;
      const message = parsed.data;
      switch (message.role) {
        case "assistant": {
          const firstStep = steps.length;
          for (const block of message.content) {
            const text = TextBlock.safeParse(block);
            if (text.success) {
              if (text.data.text) steps.push({ kind: "text", turn, text: clean(text.data.text) });
              continue;
            }
            const call = ToolCallBlock.safeParse(block);
            if (!call.success) continue;
            const { id, name, arguments: args } = call.data;
            const own = native.has(name);
            open.set(id, { own, name });
            steps.push(
              own
                ? { kind: "call", turn, callId: id, name, args }
                : { kind: "controller", turn, name },
            );
          }
          if (steps.length === firstStep) steps.push({ kind: "text", turn, text: "" });
          turn += 1;
          continue;
        }
        case "toolResult": {
          const call = open.get(message.toolCallId);
          open.delete(message.toolCallId);
          if (!call) continue;
          if (call.own) {
            steps.push({
              kind: "result",
              callId: message.toolCallId,
              output: clean(textOf(message.content)),
              isError: message.isError === true,
            });
            continue;
          }
          const claims = (claimed.get(call.name) ?? 0) + 1;
          claimed.set(call.name, claims);
          if (claims > (answered.get(call.name) ?? 0)) unverifiedCalls += 1;
          continue;
        }
        case "compactionSummary":
          steps.push({
            kind: "summary",
            turn,
            summary: clean(message.summary),
            tokensBefore: message.tokensBefore,
          });
          continue;
      }
    }
    return { steps, unverifiedCalls };
  };
}
