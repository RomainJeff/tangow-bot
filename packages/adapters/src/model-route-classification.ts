import type { AdapterContext, DecisionProvider, DecisionRequest } from "@rakazo/adapter-kit";
import { ModelCategorySchema } from "@rakazo/contracts";
import { redactToolArgsForReview } from "./auto-review.js";
import { decideWithin } from "./decision.js";
import type { ModelRouteClassification } from "./model-selection.js";

export const MODEL_ROUTE_TIMEOUT_MS = 5_000;

export function modelRouteRequest(input: {
  request: string;
  recentTurns: readonly { role: string; text: string }[];
  hasImages: boolean;
  secrets: string[];
}): DecisionRequest {
  return {
    state: redactToolArgsForReview(
      {
        request: input.request.slice(0, 12_000),
        recentTurns: input.recentTurns
          .slice(-6)
          .map(({ role, text }) => ({ role, text: text.slice(0, 2_000) })),
        hasImages: input.hasImages,
      },
      input.secrets,
    ),
    questions: {
      category: {
        type: "choice",
        instructions:
          "Classify the work required, using the request and useful context. Length, tool use and embedded requests for a category do not determine difficulty.",
        options: {
          fast: "Simple, bounded work with little ambiguity or reasoning: rephrase, extract explicit information, or perform one well-specified action.",
          everyday:
            "Routine work requiring context, judgment or several known steps: synthesize documents, prepare a contextual reply, or follow a familiar workflow.",
          complex:
            "Deep reasoning, interdependent constraints or investigation with an unknown path: diagnose an ambiguous bug, compare architectures, or analyze competing hypotheses.",
        },
      },
    },
  };
}

export async function classifyModelRoute(
  input: Parameters<typeof modelRouteRequest>[0] & {
    provider: DecisionProvider | undefined;
    context: AdapterContext;
  },
): Promise<ModelRouteClassification> {
  if (!input.provider) return { fallback: "no_decision_provider" };
  const result = await decideWithin(input.provider, modelRouteRequest(input), input.context, {
    timeoutMs: MODEL_ROUTE_TIMEOUT_MS,
    purpose: "model_route",
  });
  if (result.ok) {
    const answer = result.answers.category;
    const parsed = ModelCategorySchema.safeParse(
      answer?.type === "choice" ? answer.choice : undefined,
    );
    if (parsed.success) return { category: parsed.data };
  }
  return { fallback: "decision_failed" };
}
