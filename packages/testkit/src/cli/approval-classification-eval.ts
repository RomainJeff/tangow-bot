import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  createDecisionProvider,
  prepareDecisionProviderConnection,
  TOOL_EFFECT_PROMPT_VERSION,
  TOOL_EFFECT_TIMEOUT_MS,
} from "@rakazo/adapters";
import { DEVELOPMENT_CASES } from "../evals/approval-classification/cases.js";
import type { ApprovalCase } from "../evals/approval-classification/corpus.js";
import { corpusSha256, validateCorpus } from "../evals/approval-classification/corpus.js";
import { HOLDOUT_CASES } from "../evals/approval-classification/holdout.js";
import { CORPUS_MANIFEST } from "../evals/approval-classification/manifest.js";
import {
  classifyCases,
  effectiveClassification,
  nameRuleLabel,
  parseDecisionConnection,
  publicSettings,
  regressions,
  sentToModel,
} from "../evals/approval-classification/model-run.js";
import type { Metrics, Prediction, Report } from "../evals/approval-classification/report.js";
import { buildReport, HOLDOUT_GATE, scoreCases } from "../evals/approval-classification/report.js";

const MODES = ["heuristic", "model"] as const;
const SPLITS = ["all", "development", "holdout"] as const;
const MODEL_NOT_RUN =
  "The model classifier needs --connection <file> and --live; nothing was sent.";

function choice<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  const match = allowed.find((option) => option === value);
  if (!match) throw new Error(`Unknown ${flag} "${value}"; use one of ${allowed.join(", ")}`);
  return match;
}

function gitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function percent(ratio: { numerator: number; denominator: number; value: number | null }) {
  const share = ratio.value === null ? "n/a" : `${(ratio.value * 100).toFixed(1)}%`;
  return `${ratio.numerator}/${ratio.denominator} (${share})`;
}

function line(label: string, m: Metrics): string {
  const failures = Object.entries(m.failures)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
  return `${label}: ${m.cases} cases, ${m.notRun} not run, ${m.unavailable} unavailable${failures ? ` (${failures})` : ""}; recall ${percent(m.recall)}, false negatives ${m.falseNegatives}, false positives ${percent(m.falsePositiveRate)}, precision ${percent(m.precision)}`;
}

function gateLine(gate: Report["holdoutGate"]): string {
  const criteria = `${HOLDOUT_GATE.maxFalseNegatives} FN, at most ${HOLDOUT_GATE.maxFalsePositives} FP, ${HOLDOUT_GATE.cases}/${HOLDOUT_GATE.cases} valid`;
  if (!gate) return `Model gate (${criteria}): no holdout cases selected`;
  if (!gate.quality)
    return `Model gate (${criteria}): incomplete, ${gate.availability.valid}/${gate.availability.required} valid`;
  return `Model gate (${criteria}): ${gate.passed ? "pass" : "fail"} with ${gate.quality.falseNegatives} FN and ${gate.quality.falsePositives} FP`;
}

function write(output: string, report: unknown): void {
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${output}.tmp`, output);
}

function heuristicPredictions(cases: readonly ApprovalCase[]): Map<string, Prediction> {
  return new Map(cases.map((c) => [c.id, { kind: "classified", label: nameRuleLabel(c) }]));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "heuristic" },
      split: { type: "string", default: "all" },
      output: { type: "string" },
      repeats: { type: "string", default: "1" },
      connection: { type: "string" },
      live: { type: "boolean", default: false },
    },
  });
  const mode = choice("--mode", values.mode, MODES);
  const split = choice("--split", values.split, SPLITS);
  const repeats = Number(values.repeats);
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > HOLDOUT_GATE.repeats)
    throw new Error(`--repeats must be an integer from 1 to ${HOLDOUT_GATE.repeats}`);
  if (mode === "heuristic" && (repeats !== 1 || values.connection || values.live))
    throw new Error("--repeats, --connection and --live apply to --mode model only");
  const output = path.resolve(
    values.output ??
      `test-report/approval-classification/${mode === "heuristic" ? "baseline" : "model"}.json`,
  );

  const problems = validateCorpus({ development: DEVELOPMENT_CASES, holdout: HOLDOUT_CASES });
  if (problems.length) throw new Error(`Invalid corpus: ${problems.join("; ")}`);
  const sha256 = {
    development: corpusSha256(DEVELOPMENT_CASES),
    holdout: corpusSha256(HOLDOUT_CASES),
  };
  for (const part of ["development", "holdout"] as const)
    if (sha256[part] !== CORPUS_MANIFEST.sha256[part])
      throw new Error(
        `The ${part} cases no longer match corpus ${CORPUS_MANIFEST.version}; record a new version and hash in manifest.ts`,
      );

  const cases = [
    ...(split === "holdout" ? [] : DEVELOPMENT_CASES),
    ...(split === "development" ? [] : HOLDOUT_CASES),
  ];
  const header = {
    version: 1,
    kind: "approval-classification-benchmark",
    generatedAt: new Date().toISOString(),
    corpus: { version: CORPUS_MANIFEST.version, sha256, labels: CORPUS_MANIFEST.labels },
    gitSha: gitSha(),
    mode,
    split,
  };
  const limitations = [
    "Synthetic corpus: counts describe these invented tools, not the distribution of real calls.",
    "Variants within a group are correlated; read results per group, not only per case.",
    "No tool is executed. Only the model mode sends decision requests, and only with --live.",
  ];
  const scope = "eligible holdout cases (no readOnly hint)";

  if (mode === "heuristic") {
    const result = buildReport(scoreCases(cases, heuristicPredictions(cases)));
    write(output, {
      ...header,
      classifier: "connectorToolRequiresApproval",
      model: { status: "not-run", reason: "Heuristic mode scores the name rule only." },
      futureModelGate: { ...HOLDOUT_GATE, scope },
      limitations,
      ...result,
    });
    console.log(
      `Approval classification corpus ${CORPUS_MANIFEST.version} (labels review ${CORPUS_MANIFEST.labels.review}), mode heuristic, split ${split}.`,
    );
    console.log(line("All", result.all));
    for (const [cohort, metrics] of Object.entries(result.byCohort))
      console.log(line(`Cohort ${cohort}`, metrics));
    console.log(gateLine(result.holdoutGate));
    console.log(`Report: ${path.relative(process.cwd(), output)}`);
    if (!result.complete) process.exitCode = 1;
    return;
  }

  const modelCases = cases.filter(sentToModel);
  const nameRule = buildReport(scoreCases(cases, heuristicPredictions(cases)));
  const settings = { promptVersion: TOOL_EFFECT_PROMPT_VERSION, timeoutMs: TOOL_EFFECT_TIMEOUT_MS };
  if (!values.connection || !values.live) {
    const raw = buildReport(scoreCases(modelCases, new Map()));
    write(output, {
      ...header,
      classifier: "model",
      model: { status: "not-run", reason: MODEL_NOT_RUN, ...settings },
      gate: { ...HOLDOUT_GATE, scope, repeatsRun: 0, passed: false },
      limitations,
      nameRule,
      complete: false,
      repeats: [{ repeat: 1, raw }],
    });
    console.error(MODEL_NOT_RUN);
    console.error(`Incomplete: ${raw.all.notRun} of ${raw.all.cases} cases were not run.`);
    process.exitCode = 1;
    return;
  }

  let stored: unknown;
  try {
    stored = JSON.parse(readFileSync(values.connection, "utf8"));
  } catch {
    throw new Error("The --connection file could not be read as JSON");
  }
  let connection: Awaited<ReturnType<typeof prepareDecisionProviderConnection>>;
  try {
    connection = await prepareDecisionProviderConnection(parseDecisionConnection(stored));
  } catch {
    throw new Error("The Decision Model connection could not be prepared");
  }
  const provider = createDecisionProvider(
    connection.provider,
    connection.settings,
    connection.credentials,
  );
  const descriptor = provider.describe();
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  const runs = [];
  const models = new Set<string>();
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const answered = await classifyCases(provider, modelCases, controller.signal);
    for (const model of answered.models) models.add(model);
    const raw = buildReport(scoreCases(modelCases, answered.predictions));
    const fallback = effectiveClassification(cases, answered.predictions);
    const effective = buildReport(scoreCases(cases, fallback.predictions));
    runs.push({
      repeat,
      raw,
      effective: { ...effective, fallbacks: fallback.fallbacks },
      regressions: regressions(modelCases, answered.predictions),
    });
    console.log(line(`Repeat ${repeat} raw model`, raw.all));
    console.log(line(`Repeat ${repeat} default path after fallback`, effective.all));
    console.log(`Repeat ${repeat} ${gateLine(raw.holdoutGate)}`);
  }
  const gateSelected = runs.every((r) => r.raw.holdoutGate);
  const gatePassed =
    gateSelected &&
    runs.length >= HOLDOUT_GATE.repeats &&
    runs.every((r) => r.raw.holdoutGate?.passed && r.regressions.critical.length === 0);
  const complete = runs.every((r) => r.raw.complete);
  write(output, {
    ...header,
    classifier: "model",
    model: {
      status: "run",
      provider: connection.provider,
      adapter: { id: descriptor.id, version: descriptor.adapterVersion },
      reportedModels: [...models].sort(),
      settings: publicSettings(connection.settings),
      ...settings,
    },
    gate: { ...HOLDOUT_GATE, scope, repeatsRun: runs.length, passed: gatePassed },
    limitations: [
      ...limitations,
      "Repeats show how answers vary; they do not add independent scenarios.",
    ],
    nameRule,
    complete,
    repeats: runs,
  });
  console.log(
    `Approval classification corpus ${CORPUS_MANIFEST.version}, model mode, split ${split}, prompt ${TOOL_EFFECT_PROMPT_VERSION}, ${runs.length} repeat(s).`,
  );
  if (gateSelected)
    console.log(
      `Holdout gate over ${runs.length} repeat(s): ${gatePassed ? "pass" : "not passed"}`,
    );
  console.log(`Report: ${path.relative(process.cwd(), output)}`);
  if (!complete || (gateSelected && !gatePassed)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Approval classification eval failed");
  process.exitCode = 1;
});
