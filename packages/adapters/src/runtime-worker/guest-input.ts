import type {
  AgentRunRequest,
  ConnectorTool,
  GuestRunInput,
  HarnessCapability,
  HarnessDeclaration,
} from "@rakazo/adapter-kit";
import { guestModelOf } from "./model-relay.js";

/** Tools the controller places in the guest: they run there after a fenced grant. */
export const GUEST_TOOLS: readonly ConnectorTool[] = [
  {
    name: "bash",
    description:
      "Run a shell command in this run's workspace. Long output is cut for you, head and tail, and kept whole in a file whose path the result names.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout: { type: "number", description: "Seconds before the command is stopped." },
      },
      required: ["command"],
    },
  },
];
export const GUEST_TOOL_NAMES = new Set(GUEST_TOOLS.map((tool) => tool.name));

/** The tools a harness uses only through a capability it declares. */
const TOOL_CAPABILITY: Readonly<Record<string, HarnessCapability>> = { run_subagent: "subagents" };

export function base64Images(images: AgentRunRequest["currentTurnImages"]) {
  return (images ?? []).map((image) => ({
    name: image.name,
    mimeType: image.mimeType,
    data: Buffer.from(image.data).toString("base64"),
  }));
}

export function guestRunInput(
  request: AgentRunRequest,
  harness: HarnessDeclaration,
): GuestRunInput {
  const offered = request.tools.filter((tool) => {
    const needed = TOOL_CAPABILITY[tool.name];
    return !needed || harness.capabilities.includes(needed);
  });
  return {
    botId: request.botId,
    threadId: request.threadId,
    sourceMessageId: request.sourceMessageId,
    prompt: request.prompt,
    instructions: request.instructions,
    history: request.history.map((turn) => ({
      ...(turn.id ? { id: turn.id } : {}),
      role: turn.role,
      content: turn.content,
      ...(turn.parts ? { parts: turn.parts } : {}),
    })),
    images: base64Images(request.currentTurnImages),
    tools: offered.map(({ name, description, inputSchema, readOnly }) => ({
      name,
      description,
      inputSchema,
      ...(readOnly === undefined ? {} : { readOnly }),
      where: GUEST_TOOL_NAMES.has(name) ? "guest" : "controller",
    })),
    model: guestModelOf(request.model),
    allowSilentEmpty: request.allowSilentEmpty,
    freeTextIsPrivate: request.freeTextIsPrivate,
    runRecap: request.runRecap,
    emptyResponseText: request.emptyResponseText,
  };
}
