import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import type { AgentHistoryTurn, AgentHistoryTurnPart } from "@rakazo/contracts";
import * as z from "zod";
import { toHistory } from "../../pi-runtime.js";

/**
 * Canonical history and a native Pi session, both ways. The controller owns the canonical
 * history: a guest projects it into the session it runs, and the controller ingests what the
 * attempt added to that session.
 */

type ToolCalls = Extract<AgentHistoryTurnPart, { type: "toolCalls" }>["calls"];

/** The MCP server a native harness reaches Rakazo's controller tools through. */
export const RAKAZO_MCP_SERVER = "rakazo";

/** The name Pi's MCP client gives a tool of the Rakazo server. */
export function piMcpToolName(name: string): string {
  return `mcp__${RAKAZO_MCP_SERVER}__${name}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/**
 * The session a native Pi resumes from: the canonical turns as pi-ai messages, with every
 * controller tool under the name the harness's MCP client gives it.
 */
export function projectPiAi(
  history: AgentRunRequest["history"],
  prompt: string,
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  controllerTools: readonly string[],
  sourceMessageId?: string | null,
): Message[] {
  const controller = new Set(controllerTools);
  const rename = (name: string) => (controller.has(name) ? piMcpToolName(name) : name);
  return toHistory(history, prompt, model, sourceMessageId).map((message): Message => {
    if (message.role === "assistant") {
      return {
        ...message,
        content: message.content.map((block) =>
          block.type === "toolCall" ? { ...block, name: rename(block.name) } : block,
        ),
      };
    }
    if (message.role === "toolResult") return { ...message, toolName: rename(message.toolName) };
    return message as Message;
  });
}

/** What the controller answered one call of a controller tool, in call order. */
export type ControllerCallRecord = { name: string; output: string };

export type CanonicalEntry =
  | { kind: "turn"; turn: AgentHistoryTurn }
  | { kind: "summary"; summary: string; tokensBefore: number };

export interface IngestResult {
  entries: CanonicalEntry[];
  /** Calls of controller tools the transcript claims that the controller never answered. */
  unverifiedCalls: number;
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
  z.looseObject({ role: z.literal("toolResult"), toolCallId: z.string(), content: Content }),
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
 * The canonical entries of what an attempt added to its native session. Its first user message
 * is the run's own prompt, already canonical; a message or block canonical history has no place
 * for, such as the harness's thinking, is left out. A controller tool's output always comes from the
 * controller's record, never from the transcript, whether the harness named the tool the way its
 * MCP client does or bare. `clean` redacts and bounds every string kept from the transcript.
 */
export function ingestPiAi(
  messages: readonly unknown[],
  controllerCalls: readonly ControllerCallRecord[],
  controllerTools: readonly string[],
  clean: (text: string) => string,
): IngestResult {
  const controllerName = new Map(
    controllerTools.flatMap((name) => [
      [piMcpToolName(name), name],
      [name, name],
    ]),
  );
  const records = new Map<string, ControllerCallRecord[]>();
  for (const record of controllerCalls) {
    records.set(record.name, [...(records.get(record.name) ?? []), record]);
  }
  const entries: CanonicalEntry[] = [];
  const harnessCalls = new Map<string, ToolCalls[number]>();
  let parts: AgentHistoryTurnPart[] = [];
  let unverifiedCalls = 0;
  let promptSeen = false;
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
        const calls: ToolCalls = [];
        for (const block of message.content) {
          const text = TextBlock.safeParse(block);
          if (text.success) {
            if (text.data.text) parts.push({ type: "text", text: clean(text.data.text) });
            continue;
          }
          const call = ToolCallBlock.safeParse(block);
          if (!call.success) continue;
          const { id, name, arguments: args } = call.data;
          const controller = controllerName.get(name);
          if (controller === undefined) {
            const harnessCall = { id, name, args, output: "" };
            harnessCalls.set(id, harnessCall);
            calls.push(harnessCall);
            continue;
          }
          const record = records.get(controller)?.shift();
          if (!record) unverifiedCalls += 1;
          calls.push({ id, name: controller, args, output: record?.output ?? "" });
        }
        if (calls.length > 0) parts.push({ type: "toolCalls", calls });
        continue;
      }
      case "toolResult": {
        // The harness's own tools run in the VM, which is their boundary; a result it reports
        // for a controller tool answers nothing.
        const call = harnessCalls.get(message.toolCallId);
        if (call) call.output = clean(textOf(message.content));
        harnessCalls.delete(message.toolCallId);
        continue;
      }
      case "compactionSummary":
        flush();
        entries.push({
          kind: "summary",
          summary: clean(message.summary),
          tokensBefore: message.tokensBefore,
        });
        continue;
    }
  }
  flush();
  return { entries, unverifiedCalls };
}
