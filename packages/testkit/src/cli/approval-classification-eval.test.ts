import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cli = path.resolve(import.meta.dirname, "approval-classification-eval.ts");
const dirs: string[] = [];

function run(...args: string[]) {
  const dir = mkdtempSync(path.join(tmpdir(), "approval-eval-"));
  dirs.push(dir);
  const output = path.join(dir, "report.json");
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, ...args, "--output", output],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return {
    status: result.status,
    stderr: result.stderr,
    report: () => JSON.parse(readFileSync(output, "utf8")),
    written: () => existsSync(output),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("approval classification eval CLI", () => {
  it("scores the heuristic on every case and keeps the model not-run", () => {
    const result = run("--mode", "heuristic", "--split", "all");
    const report = result.report();

    expect(result.status).toBe(0);
    expect(report.complete).toBe(true);
    expect(report.model.status).toBe("not-run");
    expect(report.all).toMatchObject({ cases: 240, classified: 240, notRun: 0 });
    expect(report.holdoutGate.availability).toEqual({ valid: 80, required: 80, passed: true });
  });

  it("fails the model mode without inventing a score", () => {
    const result = run("--mode", "model", "--split", "holdout");
    const report = result.report();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Incomplete: 80 of 80 cases were not run.");
    expect(report.complete).toBe(false);
    expect(report.all.recall).toEqual({ numerator: 0, denominator: 40, value: null });
    expect(report.holdoutGate).toEqual({
      availability: { valid: 0, required: 80, passed: false },
      quality: null,
      passed: false,
    });
  });

  it.each([
    [["--mode", "llm"], 'Unknown --mode "llm"'],
    [["--split", "test"], 'Unknown --split "test"'],
    [["--repeat", "3"], "Unknown option '--repeat'"],
  ])("rejects %j before writing a report", (args, message) => {
    const result = run(...args);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.written()).toBe(false);
  });
});
