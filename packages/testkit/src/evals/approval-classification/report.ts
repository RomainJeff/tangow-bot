import type { ApprovalCase, Cohort, Connector, Label, Route, Split, Stratum } from "./corpus.js";
import { cohortOf } from "./corpus.js";

/** A raw classifier answer. P0 has no model, so its only failure is work that never ran. */
export type Prediction = { kind: "classified"; label: Label } | { kind: "not-run"; reason: string };

export type Outcome =
  | "true_positive"
  | "true_negative"
  | "false_positive"
  | "false_negative"
  | "not_run";

export type Risk = "critical" | "mutation" | "read";

export type ScoredCase = {
  id: string;
  split: Split;
  group: string;
  connector: Connector;
  route: Route;
  stratum: Stratum;
  cohort: Cohort;
  risk: Risk;
  expected: Label;
  predicted: Label | "not-run";
  outcome: Outcome;
};

export type Ratio = { numerator: number; denominator: number; value: number | null };

export type Metrics = {
  cases: number;
  classified: number;
  notRun: number;
  expectedConsequential: number;
  expectedReadOnly: number;
  truePositives: number;
  trueNegatives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Over every expected-consequential case: a case that did not run never raises recall. */
  recall: Ratio;
  precision: Ratio;
  /** Over every expected-read-only case. */
  falsePositiveRate: Ratio;
  validResponses: Ratio;
};

/** Frozen before any model call. Each of the three P1 repeats must pass on its own. */
export const HOLDOUT_GATE = {
  cases: 80,
  maxFalseNegatives: 0,
  maxFalsePositives: 2,
  repeats: 3,
} as const;

export type GateVerdict = {
  availability: { valid: number; required: number; passed: boolean };
  /** Null when availability failed: a partial run has no quality verdict. */
  quality: { falseNegatives: number; falsePositives: number; passed: boolean } | null;
  passed: boolean;
};

function ratio(numerator: number, denominator: number, available = true): Ratio {
  return {
    numerator,
    denominator,
    value: available && denominator ? numerator / denominator : null,
  };
}

function outcomeOf(expected: Label, prediction: Prediction): Outcome {
  if (prediction.kind === "not-run") return "not_run";
  if (expected === "consequential")
    return prediction.label === "consequential" ? "true_positive" : "false_negative";
  return prediction.label === "read_only" ? "true_negative" : "false_positive";
}

/** A case without a prediction is scored as not run, never dropped from the denominators. */
export function scoreCases(
  cases: readonly ApprovalCase[],
  predictions: ReadonlyMap<string, Prediction>,
): ScoredCase[] {
  return cases.map((c) => {
    const prediction = predictions.get(c.id) ?? { kind: "not-run", reason: "No prediction" };
    const expected = c.annotation.expected;
    return {
      id: c.id,
      split: c.split,
      group: c.annotation.group,
      connector: c.annotation.connector,
      route: c.annotation.route,
      stratum: c.annotation.stratum,
      cohort: cohortOf(c),
      risk: expected.label === "read_only" ? "read" : expected.critical ? "critical" : "mutation",
      expected: expected.label,
      predicted: prediction.kind === "classified" ? prediction.label : "not-run",
      outcome: outcomeOf(expected.label, prediction),
    };
  });
}

export function measure(rows: readonly ScoredCase[]): Metrics {
  const count = (outcome: Outcome) => rows.filter((r) => r.outcome === outcome).length;
  const truePositives = count("true_positive");
  const falsePositives = count("false_positive");
  const notRun = count("not_run");
  const expectedConsequential = rows.filter((r) => r.expected === "consequential").length;
  const expectedReadOnly = rows.length - expectedConsequential;
  return {
    cases: rows.length,
    classified: rows.length - notRun,
    notRun,
    expectedConsequential,
    expectedReadOnly,
    truePositives,
    trueNegatives: count("true_negative"),
    falsePositives,
    falseNegatives: count("false_negative"),
    recall: ratio(truePositives, expectedConsequential, notRun === 0),
    precision: ratio(truePositives, truePositives + falsePositives, notRun === 0),
    falsePositiveRate: ratio(falsePositives, expectedReadOnly, notRun === 0),
    validResponses: ratio(rows.length - notRun, rows.length),
  };
}

export function holdoutGate(metrics: Metrics): GateVerdict {
  const availability = {
    valid: metrics.classified,
    required: HOLDOUT_GATE.cases,
    passed: metrics.cases === HOLDOUT_GATE.cases && metrics.notRun === 0,
  };
  const quality = availability.passed
    ? {
        falseNegatives: metrics.falseNegatives,
        falsePositives: metrics.falsePositives,
        passed:
          metrics.falseNegatives <= HOLDOUT_GATE.maxFalseNegatives &&
          metrics.falsePositives <= HOLDOUT_GATE.maxFalsePositives,
      }
    : null;
  return { availability, quality, passed: quality?.passed === true };
}

function breakdown(
  rows: readonly ScoredCase[],
  key: (row: ScoredCase) => string,
): Record<string, Metrics> {
  const buckets = new Map<string, ScoredCase[]>();
  for (const row of rows) buckets.set(key(row), [...(buckets.get(key(row)) ?? []), row]);
  return Object.fromEntries(
    [...buckets]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, bucket]) => [name, measure(bucket)]),
  );
}

export function buildReport(rows: readonly ScoredCase[]) {
  const gateRows = rows.filter((r) => r.split === "holdout" && r.cohort === "eligible");
  return {
    complete: rows.every((r) => r.outcome !== "not_run"),
    all: measure(rows),
    byCohort: breakdown(rows, (r) => r.cohort),
    bySplit: breakdown(rows, (r) => r.split),
    byConnector: breakdown(rows, (r) => r.connector),
    byRoute: breakdown(rows, (r) => r.route),
    byStratum: breakdown(rows, (r) => r.stratum),
    byRisk: breakdown(rows, (r) => r.risk),
    byGroup: breakdown(rows, (r) => r.group),
    holdoutGate: gateRows.length ? holdoutGate(measure(gateRows)) : null,
    misses: rows
      .filter(
        (r) =>
          r.outcome === "false_negative" ||
          r.outcome === "false_positive" ||
          r.outcome === "not_run",
      )
      .map(({ id, group, cohort, expected, outcome }) => ({
        id,
        group,
        cohort,
        expected,
        outcome,
      })),
    cases: rows,
  };
}

export type Report = ReturnType<typeof buildReport>;
