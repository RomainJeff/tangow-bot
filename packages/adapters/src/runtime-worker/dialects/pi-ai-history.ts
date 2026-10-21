import type { Api, Message, Model } from "@earendil-works/pi-ai";
import type { AgentRunRequest } from "@rakazo/adapter-kit";
import { toHistory } from "../../pi-runtime.js";

/** The MCP server a native harness reaches Rakazo's controller tools through. */
export const RAKAZO_MCP_SERVER = "rakazo";

/** The name Pi gives a tool of the Rakazo MCP server (its `mcp__<server>__<tool>` rule). */
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
  return toHistory(history, prompt, model, sourceMessageId).map((message) => {
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
