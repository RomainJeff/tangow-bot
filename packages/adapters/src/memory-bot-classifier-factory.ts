import type { MemoryBotClassifier } from "@rakazo/memory";
import { localMemoryBotClassifier } from "@rakazo/memory";
import { createJevBotMemoryClassifier } from "./memory-bot-classification-jev.js";

export const memoryClassifierProviders = [
  { id: "typesafe-jev", name: "Jev · TypeSafe", defaultModel: "jev-latest" },
];

export function isMemoryClassifierProvider(provider: string): boolean {
  return provider === "local" || memoryClassifierProviders.some((item) => item.id === provider);
}

/** Provider-neutral selection boundary for a bot's prepared classification method. */
export function createMemoryBotClassifierConnection(input: {
  provider: string;
  apiKey?: string;
  model?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): MemoryBotClassifier {
  if (input.provider === "local") return localMemoryBotClassifier;
  if (input.provider !== "typesafe-jev") throw new Error("Unsupported memory classifier provider");
  if (!input.apiKey?.trim()) throw new Error("Jev API key is required");
  if (!input.model?.trim()) throw new Error("Jev model must be configured explicitly");
  return createJevBotMemoryClassifier({
    apiKey: input.apiKey,
    model: input.model,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
}

/** Probe a new connection using a synthetic, one-question method and no real memories. */
export async function verifyMemoryBotClassifierConnection(input: {
  provider: string;
  apiKey?: string;
  model?: string;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}) {
  const result = await createMemoryBotClassifierConnection(input)({
    method: {
      id: "connection-check",
      version: 1,
      instructions: "Synthetic connection probe. No user-authored method or memory is included.",
      prepared: {
        questions: [
          {
            key: "probe",
            label: "Connection check",
            instructions: "Choose the option matching this synthetic connection check.",
            options: [
              {
                key: "probe_text",
                label: "Probe text",
                description: "The synthetic text used only to confirm a typed response.",
              },
            ],
          },
        ],
      },
    },
    candidate: {
      id: "connection-check",
      revision: 1,
      content: "Synthetic classification connection check.",
    },
    neighbors: [],
  });
  if (result.abstentionReason || result.invalidResponse)
    throw new Error("Jev classification connection failed");
}
