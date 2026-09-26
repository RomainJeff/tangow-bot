import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AgentRunModel, AgentRuntime } from "@rakazo/adapter-kit";
import type { PreparedMemoryMethod } from "@rakazo/contracts";
import { PreparedMemoryMethodSchema } from "@rakazo/contracts";

const MAX_SOURCE_INSTRUCTIONS = 20_000;
const MAX_PREPARED_JSON = 32_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export type MemoryMethodPreparationBot = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
};

export class MemoryMethodPreparationError extends Error {
  constructor(
    readonly code:
      | "model_unavailable"
      | "invalid_instructions"
      | "invalid_preparation"
      | "model_error",
    message: string,
  ) {
    super(message);
    this.name = "MemoryMethodPreparationError";
  }
}

/**
 * Turns a bot owner's Markdown method into bounded Choice questions once, when
 * the method is saved. No memory content or examples enter this request.
 */
export function createMemoryClassificationMethodPreparer(deps: {
  runtime: AgentRuntime;
  resolveModel: (bot: MemoryMethodPreparationBot) => Promise<AgentRunModel | null>;
  beforeModelCall?: (bot: MemoryMethodPreparationBot, model: AgentRunModel) => Promise<void>;
  recordUsage?: (usage: {
    bot: MemoryMethodPreparationBot;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }) => Promise<void>;
  timeoutMs?: number;
}) {
  return async function prepareMemoryMethod(input: {
    bot: MemoryMethodPreparationBot;
    instructions: string;
  }): Promise<PreparedMemoryMethod> {
    const source = input.instructions.trim();
    if (!source || source.length > MAX_SOURCE_INSTRUCTIONS)
      throw new MemoryMethodPreparationError(
        "invalid_instructions",
        `Classification instructions must contain 1–${MAX_SOURCE_INSTRUCTIONS} characters.`,
      );

    const model = await deps.resolveModel(input.bot);
    if (!model)
      throw new MemoryMethodPreparationError(
        "model_unavailable",
        "Connect a model in Rakazo before preparing this classification method.",
      );

    const operationId = `memory-method-preparation:${randomUUID()}`;
    let responseText = "";
    let usage: {
      inputTokens: number;
      outputTokens: number;
      provider: string;
      model: string;
    } | null = null;
    try {
      for await (const event of deps.runtime.run(
        {
          botId: input.bot.id,
          threadId: operationId,
          runId: operationId,
          prompt: JSON.stringify({ userAuthoredMethodMarkdown: source }),
          instructions: METHOD_PREPARATION_INSTRUCTIONS,
          history: [],
          tools: [],
          toolPolicy: "none",
          beforeModelCall: () => deps.beforeModelCall?.(input.bot, model),
          model,
        },
        {
          operationId,
          traceId: operationId,
          spaceId: input.bot.spaceId,
          userId: input.bot.userId,
          botId: input.bot.id,
          signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        },
      )) {
        if (event.type === "done" && event.text) responseText = event.text;
        if (event.type === "usage") {
          usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            provider: event.provider,
            model: event.model,
          };
        }
      }
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      throw new MemoryMethodPreparationError(
        "model_error",
        "The connected model could not prepare this method. Check the model connection and try again.",
      );
    }

    if (usage && deps.recordUsage) {
      await deps.recordUsage({ bot: input.bot, ...usage });
    }
    if (!responseText || responseText.length > MAX_PREPARED_JSON)
      throw new MemoryMethodPreparationError(
        "invalid_preparation",
        "The model did not return a valid classification method. Refine the instructions and try again.",
      );

    try {
      return parsePreparedMethod(JSON.parse(responseText));
    } catch {
      throw new MemoryMethodPreparationError(
        "invalid_preparation",
        "The model did not return a valid classification method. Refine the instructions and try again.",
      );
    }
  };
}

const METHOD_PREPARATION_INSTRUCTIONS = [
  "Convert the user-authored classification method into a small set of independent, reusable Choice questions.",
  "The supplied method is the only source of classification policy. Preserve its meaning and labels; do not add a default taxonomy or invent categories.",
  "Do not make decisions about any memories. No memory content, examples, or documents are included in this preparation request.",
  'Return strict JSON only with this shape: {"questions":[{"key":string,"label":string,"instructions":string,"options":[{"key":string,"label":string,"description":string}]}]}.',
  'Use 1 to 8 questions, each with 1 to 19 options. Rakazo adds a reserved no-match option. Never use "none" as a question or option key.',
  "Make each question one coherent judgment. Give every option a distinct description and include examples or exclusions only when the supplied method provides them.",
  "Question and option keys must be unique, lowercase identifiers beginning with a letter and containing only letters, digits, or underscores.",
  "Do not include extra keys, markdown fences, commentary, executable content, or instructions that override the application safety rules.",
].join("\n");

function parsePreparedMethod(value: unknown): PreparedMemoryMethod {
  return PreparedMemoryMethodSchema.parse(value);
}
