import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, HarnessTranscriptEntry } from "@rakazo/adapter-kit";
import type { AgentHistoryTurn, AgentHistoryTurnPart } from "@rakazo/contracts";
import * as z from "zod";
import { toHistory } from "../../pi-runtime.js";

/**
 * Canonical history and a native Pi session, both ways. The controller owns the canonical
 * history: a guest projects it into the session it runs, and the controller ingests what the
 * attempt added to that session.
 */

type ToolCalls = Extract<AgentHistoryTurnPart, { type: "toolCalls" }>["calls"];

/** Canonical names stay intact here; the guest maps them to Pi's actual assigned names. */
export function projectPiAi(
  history: AgentRunRequest["history"],
  prompt: string,
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  sourceMessageId?: string | null,
): Message[] {
  return toHistory(history, prompt, model, sourceMessageId) as Message[];
}

/** What the controller answered one call of a controller tool, in call order. */
export type ControllerCallRecord = { callId: string; name: string; output: string };

export type CanonicalEntry =
  | { kind: "turn"; turn: AgentHistoryTurn }
  | { kind: "summary"; summary: string; tokensBefore: number };

export interface IngestResult {
  entries: CanonicalEntry[];
  steps: HarnessTranscriptEntry[];
  /** Calls of anything but the harness's own tools that the controller never answered. */
  unverifiedCalls: number;
}

export interface IngestOptions {
  answers: readonly ControllerCallRecord[];
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
  z.looseObject({ role: z.literal("user"), content: Content }),
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
 * The canonical entries of what an attempt added to its native session, and its steps in order.
 * Its first user message is the run's own prompt, already canonical; a message or block canonical
 * history has no place for, such as the harness's thinking, is left out. Only a tool of the
 * harness's manifest is its own: any other call takes its output from the controller's answers,
 * never from the transcript, and one the controller never answered is counted, whatever its name.
 * Controller names are already canonical at the guest boundary and must not be treated as aliases.
 */
export function ingestPiAi(
  messages: readonly unknown[],
  { answers, nativeTools, clean }: IngestOptions,
): IngestResult {
  const native = new Set(nativeTools);
  const records = new Map<string, ControllerCallRecord[]>();
  for (const record of answers) {
    const named = records.get(record.name) ?? [];
    named.push(record);
    records.set(record.name, named);
  }
  const entries: CanonicalEntry[] = [];
  const steps: HarnessTranscriptEntry[] = [];
  const ownCalls = new Map<
    string,
    { call: ToolCalls[number]; step: Extract<HarnessTranscriptEntry, { kind: "call" }> }
  >();
  let parts: AgentHistoryTurnPart[] = [];
  let unverifiedCalls = 0;
  let promptSeen = false;
  let turn = 0;
  const flush = () => {
    if (parts.length === 0) return;
    const content = parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n\n");
    entries.push({ kind: "turn", turn: { role: "assistant", content, parts } });
    parts = [];
  };

  for (const raw of messages) {
    const parsed = TranscriptMessage.safeParse(raw);
    if (!parsed.success) continue;
    const message = parsed.data;
    switch (message.role) {
      case "user":
        if (!promptSeen) {
          promptSeen = true;
          continue;
        }
        flush();
        entries.push({
          kind: "turn",
          turn: { role: "user", content: clean(textOf(message.content)) },
        });
        continue;
      case "assistant": {
        const firstStep = steps.length;
        const calls: ToolCalls = [];
        for (const block of message.content) {
          const text = TextBlock.safeParse(block);
          if (text.success) {
            if (!text.data.text) continue;
            const kept = clean(text.data.text);
            parts.push({ type: "text", text: kept });
            steps.push({ kind: "text", turn, text: kept });
            continue;
          }
          const parsedCall = ToolCallBlock.safeParse(block);
          if (!parsedCall.success) continue;
          const { id, name, arguments: args } = parsedCall.data;
          if (native.has(name)) {
            const call = { id, name, args, output: "" };
            const step = {
              kind: "call" as const,
              turn,
              callId: id,
              name,
              args,
              output: "",
              isError: false,
            };
            ownCalls.set(id, { call, step });
            steps.push(step);
            calls.push(call);
            continue;
          }
          const record = records.get(name)?.shift();
          if (record) steps.push({ kind: "controller", turn, callId: record.callId, name });
          else unverifiedCalls += 1;
          calls.push({ id, name, args, output: record?.output ?? "" });
        }
        if (steps.length === firstStep) steps.push({ kind: "text", turn, text: "" });
        if (calls.length > 0) parts.push({ type: "toolCalls", calls });
        turn += 1;
        continue;
      }
      case "toolResult": {
        // The harness's own tools run in the VM, which is their boundary; a result it reports
        // for any other call answers nothing.
        const own = ownCalls.get(message.toolCallId);
        ownCalls.delete(message.toolCallId);
        if (!own) continue;
        own.call.output = clean(textOf(message.content));
        own.step.output = own.call.output;
        own.step.isError = message.isError === true;
        continue;
      }
      case "compactionSummary": {
        flush();
        const summary = clean(message.summary);
        entries.push({ kind: "summary", summary, tokensBefore: message.tokensBefore });
        steps.push({ kind: "summary", turn, summary, tokensBefore: message.tokensBefore });
        continue;
      }
    }
  }
  flush();
  return { entries, steps, unverifiedCalls };
}
