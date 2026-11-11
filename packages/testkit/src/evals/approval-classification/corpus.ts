import { createHash } from "node:crypto";
import { readOutboundCall } from "@tangow/core";

export type Label = "consequential" | "read_only";
export type Split = "development" | "holdout";
export type Connector = "native" | "mcp";
export type Route = "direct" | "catalog";
export type Stratum = "ordinary" | "adversarial";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Tri-state source hint: absent, true or false. Absence is not the same as false. */
  readOnly?: boolean;
};

/** Everything a production classifier could see for one call, and nothing else. */
export type ClassifierInput = {
  /** The tool the model called: the catalog wrapper, or the tool itself when called directly. */
  publicName: string;
  /** The tool the executor runs after catalog resolution. */
  tool: ToolDefinition;
  args: Record<string, unknown>;
};

/** Ambiguous actions take the conservative policy label; that is a policy choice, not a fact. */
export type Expected =
  | { label: "consequential"; critical: boolean; ambiguous: boolean }
  | { label: "read_only" };

export type Annotation = {
  expected: Expected;
  rationale: string;
  group: string;
  connector: Connector;
  route: Route;
  stratum: Stratum;
  /** The model-independent protection that already requires approval in this case's context. */
  gatedElsewhere: string | null;
};

export type ApprovalCase = {
  id: string;
  split: Split;
  input: ClassifierInput;
  annotation: Annotation;
};

type SchemaField = string | Record<string, unknown>;

/**
 * Which future classifier path a case exercises. Only tools without a readOnly hint go to the
 * model; a hint of either value skips it and keeps the current name heuristic. The hint never
 * sets the expected label, and checking its presence is a metadata lookup, not a classification.
 */
export type Cohort =
  | "eligible"
  | "ambiguous"
  | "gated_elsewhere"
  | "readonly_hint_true"
  | "readonly_hint_false";

export function cohortOf(c: ApprovalCase): Cohort {
  if (c.annotation.gatedElsewhere) return "gated_elsewhere";
  if (c.input.tool.readOnly === true) return "readonly_hint_true";
  if (c.input.tool.readOnly === false) return "readonly_hint_false";
  if (c.annotation.expected.label === "consequential" && c.annotation.expected.ambiguous)
    return "ambiguous";
  return "eligible";
}

/**
 * Shorthand JSON Schema: `"string"`, `"integer?"` (optional), `"string[]"`, `"a|b"` (enum).
 * Pass a schema object for anything else.
 */
export function fields(spec: Record<string, SchemaField>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(spec)) {
    if (typeof field !== "string") {
      properties[key] = field;
      required.push(key);
      continue;
    }
    const optional = field.endsWith("?");
    const type = optional ? field.slice(0, -1) : field;
    properties[key] = type.includes("|")
      ? { type: "string", enum: type.split("|") }
      : type.endsWith("[]")
        ? { type: "array", items: { type: type.slice(0, -2) } }
        : { type };
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required };
}

export function tool(
  name: string,
  description: string,
  schema: Record<string, SchemaField>,
  readOnly?: boolean,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema: fields(schema),
    ...(readOnly === undefined ? {} : { readOnly }),
  };
}

type CallOptions = { variant?: string; stratum?: Stratum; gatedElsewhere?: string };
type CallSpec<K extends string> = CallOptions & {
  tool: K;
  expected: Expected;
  args: Record<string, unknown>;
  rationale: string;
};

function call<K extends string>(
  expected: Expected,
  toolKey: K,
  args: Record<string, unknown>,
  rationale: string,
  options: CallOptions = {},
): CallSpec<K> {
  return { tool: toolKey, expected, args, rationale, ...options };
}

export const critical = <K extends string>(
  toolKey: K,
  args: Record<string, unknown>,
  rationale: string,
  options?: CallOptions,
) =>
  call(
    { label: "consequential", critical: true, ambiguous: false },
    toolKey,
    args,
    rationale,
    options,
  );

export const mutation = <K extends string>(
  toolKey: K,
  args: Record<string, unknown>,
  rationale: string,
  options?: CallOptions,
) =>
  call(
    { label: "consequential", critical: false, ambiguous: false },
    toolKey,
    args,
    rationale,
    options,
  );

export const ambiguous = <K extends string>(
  toolKey: K,
  args: Record<string, unknown>,
  rationale: string,
  options?: CallOptions,
) =>
  call(
    { label: "consequential", critical: false, ambiguous: true },
    toolKey,
    args,
    rationale,
    options,
  );

export const read = <K extends string>(
  toolKey: K,
  args: Record<string, unknown>,
  rationale: string,
  options?: CallOptions,
) => call({ label: "read_only" }, toolKey, args, rationale, options);

/** One scenario group: variants of the same tools stay together and in one split. */
export type Scenario<K extends string> = {
  group: string;
  connector: Connector;
  stratum: Stratum;
  /** Public name of the lazy catalog wrapper when the tools are reached through it. */
  catalog?: string;
  tools: Record<K, ToolDefinition>;
  calls: CallSpec<NoInfer<K>>[];
};

export function scenario<K extends string>(spec: Scenario<K>): (split: Split) => ApprovalCase[] {
  return (split) =>
    spec.calls.map((c) => {
      const definition = spec.tools[c.tool];
      return {
        id: `${spec.group}/${c.tool}${c.variant ? `.${c.variant}` : ""}`,
        split,
        input: {
          publicName: spec.catalog ?? definition.name,
          tool: definition,
          args: c.args,
        },
        annotation: {
          expected: c.expected,
          rationale: c.rationale,
          group: spec.group,
          connector: spec.connector,
          route: spec.catalog ? "catalog" : "direct",
          stratum: c.stratum ?? spec.stratum,
          gatedElsewhere: c.gatedElsewhere ?? null,
        },
      };
    });
}

export function buildSplit(
  split: Split,
  scenarios: ReadonlyArray<(split: Split) => ApprovalCase[]>,
): ApprovalCase[] {
  return scenarios.flatMap((build) => build(split));
}

export function corpusSha256(cases: readonly ApprovalCase[]): string {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex");
}

export const CORPUS_REQUIREMENTS = {
  development: { cases: 160 },
  holdout: { cases: 80, minGroups: 30, minCriticalGroups: 10, minCriticalCases: 20 },
} as const;

const isCritical = (c: ApprovalCase) =>
  c.annotation.expected.label === "consequential" && c.annotation.expected.critical;

/** Structural rules the benchmark relies on. An empty list means the corpus is usable. */
export function validateCorpus(input: {
  development: readonly ApprovalCase[];
  holdout: readonly ApprovalCase[];
}): string[] {
  const problems: string[] = [];
  const all = [...input.development, ...input.holdout];
  const ids = new Set<string>();
  for (const c of all) {
    if (ids.has(c.id)) problems.push(`Duplicate case id ${c.id}`);
    ids.add(c.id);
    if (
      cohortOf(c) === "eligible" &&
      readOutboundCall({ toolName: c.input.tool.name, args: c.input.args }).kind !== "none"
    )
      problems.push(`Case ${c.id} requires outbound approval but is marked model-eligible`);
    const visible = JSON.stringify(c.input);
    if (visible.includes(c.id) || visible.includes(c.annotation.rationale))
      problems.push(`Classifier input of ${c.id} leaks its annotation`);
  }
  for (const split of ["development", "holdout"] as const) {
    const cases = input[split];
    const expectedSize = CORPUS_REQUIREMENTS[split].cases;
    if (cases.length !== expectedSize)
      problems.push(`${split} has ${cases.length} cases, expected ${expectedSize}`);
    const consequential = cases.filter((c) => c.annotation.expected.label === "consequential");
    if (consequential.length * 2 !== cases.length)
      problems.push(
        `${split} is unbalanced: ${consequential.length} of ${cases.length} consequential`,
      );
    if (cases.some((c) => c.split !== split))
      problems.push(`${split} contains a case of another split`);
  }
  const groupsOf = (cases: readonly ApprovalCase[]) =>
    new Set(cases.map((c) => c.annotation.group));
  const toolsOf = (cases: readonly ApprovalCase[]) => new Set(cases.map((c) => c.input.tool.name));
  const developmentGroups = groupsOf(input.development);
  const developmentTools = toolsOf(input.development);
  for (const group of groupsOf(input.holdout))
    if (developmentGroups.has(group)) problems.push(`Group ${group} appears in both splits`);
  for (const name of toolsOf(input.holdout))
    if (developmentTools.has(name)) problems.push(`Tool ${name} appears in both splits`);

  const holdout = CORPUS_REQUIREMENTS.holdout;
  for (const c of input.holdout) {
    const cohort = cohortOf(c);
    if (cohort !== "eligible") problems.push(`Holdout case ${c.id} is ${cohort}, not eligible`);
  }
  for (const cohort of ["readonly_hint_true", "readonly_hint_false"] as const)
    if (!input.development.some((c) => cohortOf(c) === cohort))
      problems.push(`development has no ${cohort} control`);
  const holdoutGroups = groupsOf(input.holdout).size;
  if (holdoutGroups < holdout.minGroups)
    problems.push(`holdout has ${holdoutGroups} groups, expected at least ${holdout.minGroups}`);
  const critical = input.holdout.filter(isCritical);
  const criticalGroups = groupsOf(critical).size;
  if (criticalGroups < holdout.minCriticalGroups)
    problems.push(
      `holdout has ${criticalGroups} critical groups, expected at least ${holdout.minCriticalGroups}`,
    );
  if (critical.length < holdout.minCriticalCases)
    problems.push(
      `holdout has ${critical.length} critical cases, expected at least ${holdout.minCriticalCases}`,
    );
  return problems;
}
