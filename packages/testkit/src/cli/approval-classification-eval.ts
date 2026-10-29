import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { connectorToolRequiresApproval } from "@rakazo/core";
import { DEVELOPMENT_CASES } from "../evals/approval-classification/cases.js";
import { corpusSha256, validateCorpus } from "../evals/approval-classification/corpus.js";
import { HOLDOUT_CASES } from "../evals/approval-classification/holdout.js";
import { CORPUS_MANIFEST } from "../evals/approval-classification/manifest.js";
import type { Metrics, Prediction, Report } from "../evals/approval-classification/report.js";
import { buildReport, HOLDOUT_GATE, scoreCases } from "../evals/approval-classification/report.js";

const MODES = ["heuristic", "model"] as const;
const SPLITS = ["all", "development", "holdout"] as const;
const MODEL_NOT_RUN = "No model classifier exists yet; it is added with the executor integration.";

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
  return `${label}: ${m.cases} cases, ${m.notRun} not run; recall ${percent(m.recall)}, false negatives ${m.falseNegatives}, false positives ${percent(m.falsePositiveRate)}, precision ${percent(m.precision)}`;
}

function gateLine(gate: Report["holdoutGate"]): string {
  const criteria = `${HOLDOUT_GATE.maxFalseNegatives} FN, at most ${HOLDOUT_GATE.maxFalsePositives} FP, ${HOLDOUT_GATE.cases}/${HOLDOUT_GATE.cases} valid`;
  if (!gate) return `Future model gate (${criteria}): no holdout cases selected`;
  if (!gate.quality)
    return `Future model gate (${criteria}): incomplete, ${gate.availability.valid}/${gate.availability.required} valid`;
  return `Future model gate (${criteria}): this classifier would ${gate.passed ? "pass" : "fail"} with ${gate.quality.falseNegatives} FN and ${gate.quality.falsePositives} FP`;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "heuristic" },
      split: { type: "string", default: "all" },
      output: { type: "string" },
    },
  });
  const mode = choice("--mode", values.mode, MODES);
  const split = choice("--split", values.split, SPLITS);
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
  const predictions = new Map<string, Prediction>(
    mode === "heuristic"
      ? cases.map((c): [string, Prediction] => [
          c.id,
          {
            kind: "classified",
            label: connectorToolRequiresApproval(c.input.tool.name) ? "consequential" : "read_only",
          },
        ])
      : [],
  );
  const result = buildReport(scoreCases(cases, predictions));
  const report = {
    version: 1,
    kind: "approval-classification-benchmark",
    generatedAt: new Date().toISOString(),
    corpus: { version: CORPUS_MANIFEST.version, sha256, labels: CORPUS_MANIFEST.labels },
    gitSha: gitSha(),
    mode,
    split,
    classifier: mode === "heuristic" ? "connectorToolRequiresApproval" : "model",
    model: { status: "not-run", reason: MODEL_NOT_RUN },
    futureModelGate: { ...HOLDOUT_GATE, scope: "eligible holdout cases (no readOnly hint)" },
    limitations: [
      "Synthetic corpus: counts describe these invented tools, not the distribution of real calls.",
      "Variants within a group are correlated; read results per group, not only per case.",
      "No tool is executed and no network call is made.",
    ],
    ...result,
  };
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(`${output}.tmp`, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(`${output}.tmp`, output);

  console.log(
    `Approval classification corpus ${CORPUS_MANIFEST.version} (labels review ${CORPUS_MANIFEST.labels.review}), mode ${mode}, split ${split}. Model classifier: not-run.`,
  );
  console.log(line("All", result.all));
  for (const [cohort, metrics] of Object.entries(result.byCohort))
    console.log(line(`Cohort ${cohort}`, metrics));
  console.log(gateLine(result.holdoutGate));
  console.log(`Report: ${path.relative(process.cwd(), output)}`);
  if (!result.complete) {
    console.error(`Incomplete: ${result.all.notRun} of ${result.all.cases} cases were not run.`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Approval classification eval failed");
  process.exitCode = 1;
}
