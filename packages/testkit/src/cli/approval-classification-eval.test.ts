import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it.each([[[]], [["--connection", "missing-connection.json"]]])(
    "fails the model mode without --live and inventing a score (%j)",
    (extra) => {
      const result = run("--mode", "model", "--split", "holdout", "--repeats", "3", ...extra);
      const report = result.report();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Incomplete: 80 of 80 cases were not run.");
      expect(report.model.status).toBe("not-run");
      expect(report.complete).toBe(false);
      expect(report.gate).toMatchObject({ repeatsRun: 0, passed: false });
      expect(report.repeats[0].raw.all.recall).toEqual({
        numerator: 0,
        denominator: 40,
        value: null,
      });
      expect(report.repeats[0].raw.holdoutGate).toEqual({
        availability: { valid: 0, required: 80, passed: false },
        quality: null,
        passed: false,
      });
    },
  );

  it("does not expose a private provider value when preparing a connection fails", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "approval-connection-"));
    dirs.push(directory);
    const connection = path.join(directory, "connection.json");
    const privateValue = "SENSITIVE-PROVIDER-MARKER";
    writeFileSync(
      connection,
      JSON.stringify({
        provider: privateValue,
        settings: {},
        credentials: { apiKey: "SENSITIVE-KEY-MARKER" },
      }),
    );
    const result = run(
      "--mode",
      "model",
      "--split",
      "development",
      "--live",
      "--connection",
      connection,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The Decision Model connection could not be prepared");
    expect(result.stderr).not.toContain(privateValue);
    expect(result.stderr).not.toContain("SENSITIVE-KEY-MARKER");
    expect(result.written()).toBe(false);
  });

  it.each([
    [["--mode", "llm"], 'Unknown --mode "llm"'],
    [["--split", "test"], 'Unknown --split "test"'],
    [["--repeat", "3"], "Unknown option '--repeat'"],
    [["--mode", "model", "--repeats", "4"], "--repeats must be an integer from 1 to 3"],
    [["--live"], "--repeats, --connection and --live apply to --mode model only"],
  ])("rejects %j before writing a report", (args, message) => {
    const result = run(...args);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.written()).toBe(false);
  });
});
