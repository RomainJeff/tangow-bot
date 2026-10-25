import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest, HarnessTranscriptEntry } from "@rakazo/adapter-kit";
import * as z from "zod";
import { toHistory } from "../../pi-runtime.js";

/**
 * Canonical history and a native Pi session, both ways. The controller owns the canonical
 * history: a guest projects it into the session it runs, and the controller ingests what the
 * attempt added to that session.
 */

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
