import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterContext, DecisionProvider, DecisionResponse } from "@rakazo/adapter-kit";
import { decideWithin, FakeDecisionProvider } from "@rakazo/adapters";
import type { BuiltDecisionCase } from "./decision-corpus.js";
import { buildDecisionRequests, corpusHash, loadDecisionCorpus } from "./decision-corpus.js";

export const DECISION_RECORDINGS_DIR = fileURLToPath(
  new URL("./fixtures/decision/recordings/", import.meta.url),
);

export interface DecisionRecording {
  provider: "openrouter";
  model: string;
  recordedAt: string;
  corpusHash: string;
  cases: Record<string, RecordedCase>;
}

/** Answers only: never a key, a header, or a URL beyond the corpus's `.test` pages. */
export type RecordedCase =
  | { requestHash: string; response: DecisionResponse }
  | { requestHash: string; unavailable: string };

export type ReplayStatus = "answered" | "unavailable" | "missing" | "stale";

export interface ReplayedCase {
  built: BuiltDecisionCase;
  status: ReplayStatus;
  choice?: string;
  /** Probability of the chosen option: what production compares with its threshold. */
  probability?: number;
  confidence?: number;
}

const REPLAY_CONTEXT: AdapterContext = {
  operationId: "decision-calibration",
  traceId: "decision-calibration",
  spaceId: "calibration",
  userId: "calibration",
  signal: new AbortController().signal,
};

export function parseDecisionRecording(value: unknown): DecisionRecording {
  assert.ok(value && typeof value === "object", "recording must be an object");
  const raw = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).sort(), [
    "cases",
    "corpusHash",
    "model",
    "provider",
    "recordedAt",
  ]);
  assert.equal(raw.provider, "openrouter");
  assert.ok(typeof raw.model === "string" && typeof raw.recordedAt === "string");
  assert.ok(typeof raw.corpusHash === "string");
  assert.ok(raw.cases && typeof raw.cases === "object");
  for (const [id, entry] of Object.entries(raw.cases as Record<string, unknown>)) {
    assert.ok(entry && typeof entry === "object", `recording case ${id}`);
    const keys = Object.keys(entry).sort();
    assert.ok(
      keys.join() === "requestHash,response" || keys.join() === "requestHash,unavailable",
      `recording case ${id}: keys`,
    );
    const response = (entry as { response?: Record<string, unknown> }).response;
    if (response) {
      assert.ok(
        Object.keys(response).every((key) => ["answers", "model", "usage"].includes(key)),
        `recording case ${id}: response keeps answers, model and usage only`,
      );
    }
  }
  return structuredClone(raw) as unknown as DecisionRecording;
}

/**
 * Replays recorded answers through `decideWithin`, so an answer production would
 * reject counts as unavailable. A case whose request changed since recording is
 * `stale` and never measured.
 */
export async function replayDecisionRecording(
  built: BuiltDecisionCase[],
  recording: DecisionRecording,
): Promise<ReplayedCase[]> {
  const replayed: ReplayedCase[] = [];
  for (const item of built) {
    const recorded = recording.cases[item.caseId];
    if (!recorded) {
      replayed.push({ built: item, status: "missing" });
      continue;
    }
    if (recorded.requestHash !== item.requestHash) {
      replayed.push({ built: item, status: "stale" });
      continue;
    }
    if (!("response" in recorded)) {
      replayed.push({ built: item, status: "unavailable" });
      continue;
    }
    const provider = new FakeDecisionProvider({ script: [recorded.response] });
    const result = await decideWithin(provider, item.request, REPLAY_CONTEXT, {
      timeoutMs: 5_000,
    });
    const question = item.purpose === "target" ? "target" : "outcome";
    const answer = result.ok ? result.answers[question] : undefined;
    if (answer?.type !== "choice") {
      replayed.push({ built: item, status: "unavailable" });
      continue;
    }
    replayed.push({
      built: item,
      status: "answered",
      choice: answer.choice,
      probability: answer.probabilities[answer.choice]!,
      confidence: answer.confidence,
    });
  }
  return replayed;
}

/** Calls a real provider once per case, in order. Manual only; never run by tests or CI. */
export async function recordDecisionCorpus(
  built: BuiltDecisionCase[],
  provider: DecisionProvider,
  options: { timeoutMs: number; now?: () => Date },
): Promise<DecisionRecording> {
  const cases: Record<string, RecordedCase> = {};
  let model: string | undefined;
  for (const item of built) {
    try {
      const response = await provider.decide(item.request, {
        ...REPLAY_CONTEXT,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      model ??= response.model;
      cases[item.caseId] = {
        requestHash: item.requestHash,
        response: {
          answers: response.answers,
          ...(response.model ? { model: response.model } : {}),
          ...(response.usage ? { usage: response.usage } : {}),
        },
      };
    } catch (error) {
      cases[item.caseId] = {
        requestHash: item.requestHash,
        unavailable:
          error instanceof Error && error.name === "TimeoutError" ? "timeout" : errorName(error),
      };
    }
  }
  return {
    provider: "openrouter",
    model: model ?? "unknown",
    recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    corpusHash: corpusHash(built),
    cases,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name || "Error" : "Error";
}

export interface ThresholdRow {
  threshold: number;
  /** Target: acted on the choice. Verify: reported the class. */
  executedRate: number;
  /** Target: executed a ref that is not the labeled element. Verify: reported a wrong class. */
  wrongRate: number;
  /** Target: handed back to the model. Verify: `uncertain` or unavailable. */
  returnedRate: number;
  /** Share of executed cases that were right. */
  accuracy: number;
}

export interface GroupMetrics {
  cases: number;
  answered: number;
  accuracy: number;
  /** Expected calibration error, 10 equal-width bins, on the chosen option's probability. */
  ece: number;
  /** Same, on the answer's `confidence`. */
  eceConfidence: number;
  thresholds: ThresholdRow[];
}

export const TARGET_THRESHOLDS = steps(0.5, 0.95);
export const VERIFY_THRESHOLDS = steps(0.2, 0.8);

function steps(from: number, to: number): number[] {
  const values: number[] = [];
  for (
    let hundredths = Math.round(from * 100);
    hundredths <= Math.round(to * 100);
    hundredths += 5
  ) {
    values.push(hundredths / 100);
  }
  return values;
}

function isCorrect(item: ReplayedCase): boolean {
  return item.status === "answered" && item.choice === item.built.expectedKey;
}

/** Stale and missing cases are excluded: they were not measured. */
export function groupMetrics(items: ReplayedCase[], thresholds: number[]): GroupMetrics {
  const measured = items.filter(
    (item) => item.status === "answered" || item.status === "unavailable",
  );
  const answered = measured.filter((item) => item.status === "answered");
  const purpose = measured[0]?.built.purpose;
  const acts = (item: ReplayedCase, threshold: number) =>
    item.status === "answered" &&
    item.probability! >= threshold &&
    !(purpose === "target" && item.choice === "none");
  return {
    cases: measured.length,
    answered: answered.length,
    accuracy: ratio(answered.filter(isCorrect).length, answered.length),
    ece: expectedCalibrationError(answered, (item) => item.probability!),
    eceConfidence: expectedCalibrationError(answered, (item) => item.confidence!),
    thresholds: thresholds.map((threshold) => {
      const executed = measured.filter((item) => acts(item, threshold));
      const right = executed.filter(isCorrect).length;
      return {
        threshold,
        executedRate: ratio(executed.length, measured.length),
        wrongRate: ratio(executed.length - right, measured.length),
        returnedRate: ratio(measured.length - executed.length, measured.length),
        accuracy: ratio(right, executed.length),
      };
    }),
  };
}

function expectedCalibrationError(
  items: ReplayedCase[],
  score: (item: ReplayedCase) => number,
): number {
  if (items.length === 0) return 0;
  const bins = Array.from({ length: 10 }, () => ({ count: 0, correct: 0, total: 0 }));
  for (const item of items) {
    const value = score(item);
    const bin = bins[Math.min(9, Math.floor(value * 10))]!;
    bin.count += 1;
    bin.total += value;
    if (isCorrect(item)) bin.correct += 1;
  }
  return bins.reduce(
    (sum, bin) =>
      bin.count === 0
        ? sum
        : sum +
          (bin.count / items.length) * Math.abs(bin.correct / bin.count - bin.total / bin.count),
    0,
  );
}

function ratio(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

/** Smallest threshold executing a wrong ref on at most 1 % of target cases; ticket 06 criterion. */
export function recommendTargetThreshold(items: ReplayedCase[]): number | undefined {
  const target = items.filter((item) => item.built.purpose === "target");
  return groupMetrics(target, TARGET_THRESHOLDS).thresholds.find((row) => row.wrongRate <= 0.01)
    ?.threshold;
}

/**
 * Ticket 06 criterion for the verify threshold: `uncertain` on at least 90 % of the
 * misclassified boundary cases, and on at most 20 % of the clear cases.
 */
export function outcomeThresholdHolds(items: ReplayedCase[], threshold: number): boolean {
  const answered = items.filter(
    (item) => item.built.purpose === "verify" && item.status === "answered",
  );
  const missed = answered.filter((item) => item.built.boundary && !isCorrect(item));
  const clear = answered.filter((item) => !item.built.boundary);
  const uncertain = (list: ReplayedCase[]) =>
    ratio(list.filter((item) => item.probability! < threshold).length, list.length);
  return (missed.length === 0 || uncertain(missed) >= 0.9) && uncertain(clear) <= 0.2;
}

export interface CalibrationReport {
  recording: { model: string; recordedAt: string; cost: number; corpusMatches: boolean };
  statuses: Record<ReplayStatus, number>;
  target: Record<"all" | "fr" | "en" | "cross", GroupMetrics>;
  targetAccuracy: { family: Record<string, number>; options: Record<string, number>; none: number };
  verify: Record<"all" | "fr" | "en", GroupMetrics>;
  verifyConfusion: Record<string, Record<string, number>>;
  recommendedTarget?: number;
  /** Verify thresholds meeting the ticket 06 criterion. */
  verifyHolding: number[];
}

export function calibrationReport(
  recording: DecisionRecording,
  built: BuiltDecisionCase[],
  replayed: ReplayedCase[],
): CalibrationReport {
  const statuses: Record<ReplayStatus, number> = {
    answered: 0,
    unavailable: 0,
    missing: 0,
    stale: 0,
  };
  for (const item of replayed) statuses[item.status] += 1;
  const target = replayed.filter((item) => item.built.purpose === "target");
  const verify = replayed.filter((item) => item.built.purpose === "verify");
  const byLang = (list: ReplayedCase[], lang: string) =>
    list.filter((item) => item.built.lang === lang);
  const accuracyBy = (list: ReplayedCase[], key: (item: ReplayedCase) => string) => {
    const groups = new Map<string, ReplayedCase[]>();
    for (const item of list.filter((entry) => entry.status === "answered")) {
      groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
    }
    return Object.fromEntries(
      [...groups].map(([name, items]) => [
        name,
        ratio(items.filter(isCorrect).length, items.length),
      ]),
    );
  };
  const confusion: Record<string, Record<string, number>> = {};
  for (const item of verify.filter((entry) => entry.status === "answered")) {
    const row = confusion[item.built.expectedKey] ?? {};
    row[item.choice!] = (row[item.choice!] ?? 0) + 1;
    confusion[item.built.expectedKey] = row;
  }
  const expectsNone = target.filter(
    (item) => item.status === "answered" && item.built.expectedKey === "none",
  );
  return {
    recording: {
      model: recording.model,
      recordedAt: recording.recordedAt,
      cost: Object.values(recording.cases).reduce(
        (sum, entry) => sum + ("response" in entry ? (entry.response.usage?.cost ?? 0) : 0),
        0,
      ),
      corpusMatches: recording.corpusHash === corpusHash(built),
    },
    statuses,
    target: {
      all: groupMetrics(target, TARGET_THRESHOLDS),
      fr: groupMetrics(byLang(target, "fr"), TARGET_THRESHOLDS),
      en: groupMetrics(byLang(target, "en"), TARGET_THRESHOLDS),
      cross: groupMetrics(byLang(target, "cross"), TARGET_THRESHOLDS),
    },
    targetAccuracy: {
      family: accuracyBy(target, (item) => item.built.family),
      options: accuracyBy(target, (item) => optionBand(item.built.optionCount)),
      none: ratio(expectsNone.filter(isCorrect).length, expectsNone.length),
    },
    verify: {
      all: groupMetrics(verify, VERIFY_THRESHOLDS),
      fr: groupMetrics(byLang(verify, "fr"), VERIFY_THRESHOLDS),
      en: groupMetrics(byLang(verify, "en"), VERIFY_THRESHOLDS),
    },
    verifyConfusion: confusion,
    recommendedTarget: recommendTargetThreshold(replayed),
    verifyHolding: VERIFY_THRESHOLDS.filter((threshold) =>
      outcomeThresholdHolds(replayed, threshold),
    ),
  };
}

/** Option count includes `none`, so 21 options means 20 candidates. */
function optionBand(optionCount: number): string {
  const candidates = optionCount - 1;
  if (candidates <= 20) return "<=20";
  if (candidates <= 40) return "<=40";
  return "<=80";
}

export function formatCalibrationReport(
  report: CalibrationReport,
  production: { target: number; verify: number },
): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `Recording: model ${report.recording.model}, recorded ${report.recording.recordedAt}, cost ${report.recording.cost.toFixed(6)}`,
    report.recording.corpusMatches
      ? "Corpus: unchanged since recording."
      : "Corpus: changed since recording; stale and missing cases are not measured.",
    `Cases: ${report.statuses.answered} answered, ${report.statuses.unavailable} unavailable, ${report.statuses.stale} stale, ${report.statuses.missing} missing.`,
  ];
  const table = (
    title: string,
    metrics: GroupMetrics,
    current: number,
    labels: [string, string],
  ) => {
    lines.push(
      "",
      `${title}: ${metrics.cases} cases, accuracy ${pct(metrics.accuracy)}, ECE ${metrics.ece.toFixed(3)} (confidence ${metrics.eceConfidence.toFixed(3)})`,
    );
    if (metrics.cases === 0) return;
    lines.push(`  threshold  ${labels[0].padEnd(9)} wrong     ${labels[1].padEnd(9)} accuracy`);
    for (const row of metrics.thresholds) {
      lines.push(
        `  ${row.threshold.toFixed(2)}${row.threshold === current ? "*" : " "}      ${pct(row.executedRate).padEnd(9)} ${pct(row.wrongRate).padEnd(9)} ${pct(row.returnedRate).padEnd(9)} ${pct(row.accuracy)}`,
      );
    }
  };
  for (const lang of ["all", "fr", "en", "cross"] as const) {
    table(`Target (${lang})`, report.target[lang], production.target, ["executed", "returned"]);
  }
  lines.push(
    "",
    `Target accuracy by family: ${formatShares(report.targetAccuracy.family, pct)}`,
    `Target accuracy by options: ${formatShares(report.targetAccuracy.options, pct)}`,
    `Target none correct: ${pct(report.targetAccuracy.none)}`,
    report.recommendedTarget === undefined
      ? "Target threshold: no value up to 0.95 keeps wrong refs at or below 1%."
      : `Target threshold: smallest value with wrong refs at or below 1% is ${report.recommendedTarget.toFixed(2)}.`,
  );
  for (const lang of ["all", "fr", "en"] as const) {
    table(`Verify (${lang})`, report.verify[lang], production.verify, ["reported", "uncertain"]);
  }
  lines.push(
    "",
    report.verifyHolding.length
      ? `Verify thresholds meeting the criterion: ${report.verifyHolding.map((value) => value.toFixed(2)).join(", ")}.`
      : "Verify thresholds meeting the criterion: none.",
    "Verify confusion (expected -> answered):",
  );
  for (const [expected, row] of Object.entries(report.verifyConfusion)) {
    lines.push(`  ${expected}: ${formatShares(row, String)}`);
  }
  lines.push("", "* current production threshold. Latency is not measured by replay.");
  return lines.join("\n");
}

function formatShares(values: Record<string, number>, format: (value: number) => string): string {
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? entries.map(([key, value]) => `${key} ${format(value)}`).join(", ") : "-";
}

export function findDecisionRecordings(directory = DECISION_RECORDINGS_DIR): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => path.join(directory, file));
}

/**
 * Offline evaluation: never builds a network provider. Without a recording it says
 * so and succeeds, because the corpus alone cannot justify a threshold.
 */
export async function runDecisionCalibration(options: {
  recordings: string[];
  production: { target: number; verify: number };
  write: (text: string) => void;
}): Promise<void> {
  const built = await buildDecisionRequests(loadDecisionCorpus());
  const count = (purpose: string, lang: string) =>
    built.filter((item) => item.purpose === purpose && item.lang === lang).length;
  options.write(
    `Corpus: ${built.length} cases (target fr ${count("target", "fr")}, en ${count("target", "en")}, cross ${count("target", "cross")}; verify fr ${count("verify", "fr")}, en ${count("verify", "en")}).`,
  );
  if (options.recordings.length === 0) {
    options.write(
      "No recordings: nothing to evaluate. Thresholds stay at their starting values until a real recording is committed (see docs/agent-verification.md).",
    );
    return;
  }
  for (const file of options.recordings) {
    const recording = parseDecisionRecording(JSON.parse(readFileSync(file, "utf8")));
    const replayed = await replayDecisionRecording(built, recording);
    options.write(`\n== ${path.basename(file)}`);
    options.write(
      formatCalibrationReport(calibrationReport(recording, built, replayed), options.production),
    );
  }
}
