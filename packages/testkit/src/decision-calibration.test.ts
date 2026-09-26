import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DecisionResponse } from "@rakazo/adapter-kit";
import {
  FakeDecisionProvider,
  OUTCOME_PROBABILITY_LOW,
  TARGET_PROBABILITY_HIGH,
} from "@rakazo/adapters";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionRecording } from "./decision-calibration.js";
import {
  calibrationReport,
  findDecisionRecordings,
  outcomeThresholdHolds,
  parseDecisionRecording,
  recordDecisionCorpus,
  replayDecisionRecording,
  runDecisionCalibration,
} from "./decision-calibration.js";
import type { BuiltDecisionCase, DecisionCase, OutcomeCase } from "./decision-corpus.js";
import { buildDecisionRequests, corpusHash, loadDecisionCorpus } from "./decision-corpus.js";

const PAGE = {
  url: "https://boutique.test/compte",
  title: "Compte",
  html: '<a href="/f">Factures</a><a href="/c">Commandes</a><a href="/r">Retours</a>',
};
const target = (id: string, text: string, expected: string | "none"): DecisionCase => ({
  id,
  family: "distractors",
  lang: "fr",
  kind: "click",
  page: PAGE,
  target: text,
  expected: expected === "none" ? "none" : { role: "link", name: expected },
});
const outcome = (
  id: string,
  expected: OutcomeCase["expected"],
  boundary: boolean,
): DecisionCase => ({
  id,
  family: "outcome",
  lang: "en",
  ...(boundary ? { boundary: true as const } : {}),
  before: { url: "https://shop.test/", title: "Home", html: '<a href="/a">Account</a>' },
  after: { url: `https://shop.test/${id}`, title: id, html: '<a href="/">Home</a>' },
  action: { kind: "click", role: "link", name: "Account" },
  expected,
});

function keyOf(item: BuiltDecisionCase, label: string): string {
  const question = item.request.questions.target;
  if (question?.type !== "choice") throw new Error("expected a target choice");
  return Object.keys(question.options).find((key) => question.options[key] === label)!;
}

function choice(
  question: string,
  picked: string,
  probabilities: Record<string, number>,
  confidence: number,
): DecisionResponse {
  return {
    answers: { [question]: { type: "choice", choice: picked, confidence, probabilities } },
    usage: { inputTokens: 100, cost: 0.001 },
  };
}

async function handRecording() {
  const built = await buildDecisionRequests([
    target("a", "les factures", "Factures"),
    target("b", "les commandes", "Commandes"),
    target("c", "la météo", "none"),
    target("d", "les retours", "Retours"),
    target("e", "le panier", "none"),
    target("f", "les factures", "Factures"),
    outcome("v1", "landed", false),
    outcome("v2", "error", true),
    outcome("v3", "auth", false),
  ]);
  const [a, b, c, d, e, , v1, v2, v3] = built;
  const factures = keyOf(a!, 'link "Factures"');
  const commandes = keyOf(b!, 'link "Commandes"');
  const retours = keyOf(b!, 'link "Retours"');
  const recording: DecisionRecording = {
    provider: "openrouter",
    model: "synthetic",
    recordedAt: "2026-09-26T00:00:00.000Z",
    corpusHash: corpusHash(built),
    cases: {
      a: {
        requestHash: a!.requestHash,
        response: choice("target", factures, { [factures]: 0.9, none: 0.1 }, 0.8),
      },
      b: {
        requestHash: b!.requestHash,
        response: choice("target", retours, { [retours]: 0.85, [commandes]: 0.15 }, 0.7),
      },
      c: {
        requestHash: c!.requestHash,
        response: choice("target", "none", { none: 0.6, [factures]: 0.4 }, 0.5),
      },
      d: { requestHash: d!.requestHash, unavailable: "timeout" },
      // A ref outside the offered options: production rejects it as invalid_answer.
      e: { requestHash: e!.requestHash, response: choice("target", "e99", { e99: 1 }, 1) },
      // Recorded against a request that has since changed.
      f: {
        requestHash: "0".repeat(64),
        response: choice("target", factures, { [factures]: 1 }, 1),
      },
      v1: {
        requestHash: v1!.requestHash,
        response: choice("outcome", "landed", { landed: 0.9, dialog: 0.1 }, 0.9),
      },
      v2: {
        requestHash: v2!.requestHash,
        response: choice(
          "outcome",
          "unchanged",
          { unchanged: 0.4, error: 0.35, landed: 0.25 },
          0.3,
        ),
      },
      v3: {
        requestHash: v3!.requestHash,
        response: choice("outcome", "auth", { auth: 0.45, landed: 0.3, error: 0.25 }, 0.4),
      },
    },
  };
  return { built, recording };
}

describe("decision calibration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes rates and calibration error from replayed answers, skipping stale ones", async () => {
    const { built, recording } = await handRecording();
    const replayed = await replayDecisionRecording(built, parseDecisionRecording(recording));
    const report = calibrationReport(recording, built, replayed);
    // Six target cases: f is stale, so five are measured; a, b, c answered; d and e unavailable.
    expect(report.statuses).toEqual({ answered: 6, unavailable: 2, missing: 0, stale: 1 });
    const all = report.target.all;
    expect(all.cases).toBe(5);
    expect(all.answered).toBe(3);
    expect(all.accuracy).toBeCloseTo(2 / 3);
    // Bins: a 0.9 right, b 0.85 wrong, c 0.6 right -> (0.1 + 0.85 + 0.4) / 3.
    expect(all.ece).toBeCloseTo(1.35 / 3);
    // Confidence bins: 0.8 right, 0.7 wrong, 0.5 right -> (0.2 + 0.7 + 0.5) / 3.
    expect(all.eceConfidence).toBeCloseTo(1.4 / 3);
    const at = (threshold: number) => all.thresholds.find((row) => row.threshold === threshold)!;
    // At 0.80 a and b execute (c chose none): 2/5 executed, b is a wrong ref.
    expect(at(0.8)).toEqual({
      threshold: 0.8,
      executedRate: 0.4,
      wrongRate: 0.2,
      returnedRate: 0.6,
      accuracy: 0.5,
    });
    // At 0.50 c clears the bar but chose none, which is never executed.
    expect(at(0.5)).toEqual({ ...at(0.8), threshold: 0.5 });
    expect(at(0.9)).toEqual({
      threshold: 0.9,
      executedRate: 0.2,
      wrongRate: 0,
      returnedRate: 0.8,
      accuracy: 1,
    });
    expect(report.recommendedTarget).toBe(0.9);
    expect(report.targetAccuracy.none).toBe(1);
    expect(report.recording.cost).toBeCloseTo(0.007);
    // Verify at 0.5: only v1 is reported (v2 0.40 and v3 0.45 are uncertain).
    const verify = report.verify.all.thresholds.find((row) => row.threshold === 0.5)!;
    expect(verify).toEqual({
      threshold: 0.5,
      executedRate: 1 / 3,
      wrongRate: 0,
      returnedRate: 2 / 3,
      accuracy: 1,
    });
    expect(report.verifyConfusion).toEqual({
      landed: { landed: 1 },
      error: { unchanged: 1 },
      auth: { auth: 1 },
    });
    // Criterion: the missed boundary case (v2, 0.40) must be uncertain, at most 20 % of clear ones.
    expect(outcomeThresholdHolds(replayed, 0.5)).toBe(false);
    expect(outcomeThresholdHolds(replayed, 0.42)).toBe(true);
    expect(outcomeThresholdHolds(replayed, 0.35)).toBe(false);
  });

  it("records answers only, and its recording replays against the same requests", async () => {
    const { built } = await handRecording();
    const cases = built.slice(0, 2);
    const provider = new FakeDecisionProvider({
      script: [
        (request) => ({
          ...choice(
            "target",
            keyOf(cases[0]!, 'link "Factures"'),
            { [keyOf(cases[0]!, 'link "Factures"')]: 1 },
            1,
          ),
          model: "typesafe/jev-test",
          legend: "dropped",
          request,
        }),
        new Error("boom"),
      ],
    });
    const recording = await recordDecisionCorpus(cases, provider, { timeoutMs: 1_000 });
    const recorded = recording.cases.a!;
    expect("response" in recorded && Object.keys(recorded.response).sort()).toEqual([
      "answers",
      "model",
      "usage",
    ]);
    expect(recording.cases.b).toEqual({ requestHash: cases[1]!.requestHash, unavailable: "Error" });
    expect(recording.model).toBe("typesafe/jev-test");
    const replayed = await replayDecisionRecording(cases, parseDecisionRecording(recording));
    expect(replayed.map((item) => item.status)).toEqual(["answered", "unavailable"]);
  });

  it("says there is nothing to evaluate without recordings, offline", async () => {
    const empty = mkdtempSync(path.join(tmpdir(), "decision-recordings-"));
    try {
      expect(findDecisionRecordings(empty)).toEqual([]);
      expect(findDecisionRecordings(path.join(empty, "absent"))).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    const fetch = vi.fn(() => Promise.reject(new Error("network")));
    vi.stubGlobal("fetch", fetch);
    const lines: string[] = [];
    await runDecisionCalibration({
      recordings: [],
      production: { target: TARGET_PROBABILITY_HIGH, verify: OUTCOME_PROBABILITY_LOW },
      write: (text) => lines.push(text),
    });
    expect(lines.join("\n")).toMatch(
      /^Corpus: \d+ cases[\s\S]*\nNo recordings: nothing to evaluate/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  const real = findDecisionRecordings();
  it.skipIf(real.length === 0)(
    "keeps the production thresholds within the ticket 06 criteria on every real recording (skipped until one is committed)",
    async () => {
      const built = await buildDecisionRequests(loadDecisionCorpus());
      for (const file of real) {
        const recording = parseDecisionRecording(JSON.parse(readFileSync(file, "utf8")));
        const replayed = await replayDecisionRecording(built, recording);
        const report = calibrationReport(recording, built, replayed);
        const row = report.target.all.thresholds.find(
          (entry) => entry.threshold === TARGET_PROBABILITY_HIGH,
        );
        expect(row?.wrongRate, path.basename(file)).toBeLessThanOrEqual(0.01);
        expect(outcomeThresholdHolds(replayed, OUTCOME_PROBABILITY_LOW), path.basename(file)).toBe(
          true,
        );
      }
    },
  );
});
