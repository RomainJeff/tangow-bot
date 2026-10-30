import type { DecisionProvider } from "@rakazo/adapter-kit";
import { classifyToolEffect } from "@rakazo/adapters";
import { connectorToolRequiresApproval } from "@rakazo/core";
import type { ApprovalCase, Label } from "./corpus.js";
import { cohortOf } from "./corpus.js";
import type { Prediction } from "./report.js";

/** The current name rule, which the executor keeps for every call it does not classify. */
export function nameRuleLabel(c: ApprovalCase): Label {
  return connectorToolRequiresApproval(c.input.tool.name) ? "consequential" : "read_only";
}

/**
 * Cases the executor would send to the model: no readOnly hint and no protection that already
 * asks. Ambiguous cases are sent too and scored apart through their cohort.
 */
export function sentToModel(c: ApprovalCase): boolean {
  const cohort = cohortOf(c);
  return cohort === "eligible" || cohort === "ambiguous";
}

/**
 * One pass over the cases, one request each, in order: no retry and no cached answer. Only the
 * call a production executor would see is sent; ids and annotations stay here.
 */
export async function classifyCases(
  provider: DecisionProvider,
  cases: readonly ApprovalCase[],
  signal: AbortSignal,
): Promise<{ predictions: Map<string, Prediction>; models: Set<string> }> {
  const predictions = new Map<string, Prediction>();
  const models = new Set<string>();
  for (const c of cases) {
    const result = await classifyToolEffect({
      provider,
      call: c.input,
      secrets: [
        ...new Set(JSON.stringify(c.input).match(/SYNTHETIC-SECRET-MARKER-[A-Z0-9-]+/g) ?? []),
      ],
      context: {
        operationId: "approval-classification-eval",
        traceId: "approval-classification-eval",
        spaceId: "benchmark",
        userId: "benchmark",
        signal,
      },
    });
    if (result.ok && result.model) models.add(result.model);
    predictions.set(
      c.id,
      result.ok
        ? { kind: "classified", label: result.effect }
        : { kind: "unavailable", reason: result.reason },
    );
  }
  return { predictions, models };
}

/**
 * What the default path decides: the model's label when it answered, otherwise the name rule.
 * Calls never sent to the model keep the name rule without counting as a fallback.
 */
export function effectiveClassification(
  cases: readonly ApprovalCase[],
  raw: ReadonlyMap<string, Prediction>,
) {
  const predictions = new Map<string, Prediction>();
  const fallbacks: Array<{ id: string; reason: string }> = [];
  for (const c of cases) {
    const answer = raw.get(c.id);
    if (answer?.kind === "classified") {
      predictions.set(c.id, answer);
      continue;
    }
    if (answer) fallbacks.push({ id: c.id, reason: answer.reason });
    predictions.set(c.id, { kind: "classified", label: nameRuleLabel(c) });
  }
  return { predictions, fallbacks };
}

/** Mutations the name rule caught and the model labelled read_only. */
export function regressions(cases: readonly ApprovalCase[], raw: ReadonlyMap<string, Prediction>) {
  const missed = cases.filter((c) => {
    const answer = raw.get(c.id);
    return (
      c.annotation.expected.label === "consequential" &&
      nameRuleLabel(c) === "consequential" &&
      answer?.kind === "classified" &&
      answer.label === "read_only"
    );
  });
  const critical = (c: ApprovalCase) =>
    c.annotation.expected.label === "consequential" && c.annotation.expected.critical;
  return {
    critical: missed.filter(critical).map((c) => c.id),
    other: missed.filter((c) => !critical(c)).map((c) => c.id),
  };
}

export type DecisionConnection = {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
};

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Connection ${field} must be an object of strings`);
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string"))
    throw new Error(`Connection ${field} must be an object of strings`);
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Shape check only. Messages name fields, never values. */
export function parseDecisionConnection(value: unknown): DecisionConnection {
  if (!value || typeof value !== "object") throw new Error("Connection must be a JSON object");
  const { provider, settings, credentials } = value as Record<string, unknown>;
  if (typeof provider !== "string" || !provider)
    throw new Error("Connection provider must be a string");
  return {
    provider,
    settings: stringRecord(settings ?? {}, "settings"),
    credentials: stringRecord(credentials ?? {}, "credentials"),
  };
}

/** Settings a report may name: values that are not URLs or file paths. Credentials never are. */
export function publicSettings(settings: Record<string, string>) {
  const shown: Record<string, string> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (URL.canParse(value) || /^[./~\\]|^[a-z]:\\/i.test(value)) withheld.push(key);
    else shown[key] = value;
  }
  return { shown, withheld };
}
