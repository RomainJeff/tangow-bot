import { readFileSync } from "node:fs";
import type { DecisionRequest } from "@tangow/adapter-kit";

/**
 * The documented OpenRouter Decisions example (openrouter-decision.json, copied
 * verbatim from https://openrouter.ai/openapi.json, operation createApiAlphaDecisions).
 */
export interface OpenRouterDecisionFixture {
  _source: Record<string, string>;
  request: {
    model: string;
    state: Record<string, unknown>;
    questions: Record<string, { type: string; instructions: string; criteria: unknown }>;
  };
  response: Record<string, unknown>;
  errors: Record<string, unknown>;
}

export function loadOpenRouterDecisionFixture(): OpenRouterDecisionFixture {
  return JSON.parse(
    readFileSync(new URL("./openrouter-decision.json", import.meta.url), "utf8"),
  ) as OpenRouterDecisionFixture;
}

/**
 * The neutral request that corresponds to the documented example. The neutral
 * `noul` carries no criteria (optional in both the OpenRouter schema and the
 * TypeSafe API reference), so the wire body differs from the example only by
 * `questions.is_bug.criteria`.
 */
export function documentedDecisionRequest(fixture: OpenRouterDecisionFixture): DecisionRequest {
  const { is_bug, team, urgency } = fixture.request.questions;
  return {
    state: fixture.request.state,
    questions: {
      is_bug: { type: "noul", instructions: is_bug!.instructions },
      team: {
        type: "choice",
        instructions: team!.instructions,
        options: team!.criteria as Record<string, string>,
      },
      urgency: {
        type: "score",
        instructions: urgency!.instructions,
        levels: urgency!.criteria as string[],
      },
    },
  };
}

/** The documented request body as this adapter sends it (see `documentedDecisionRequest`). */
export function documentedWireBody(fixture: OpenRouterDecisionFixture): unknown {
  const body = structuredClone(fixture.request);
  const { criteria: _criteria, ...isBug } = body.questions.is_bug!;
  body.questions.is_bug = isBug as (typeof body.questions)["is_bug"];
  return body;
}
