import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createDecisionProvider,
  OUTCOME_PROBABILITY_LOW,
  TARGET_PROBABILITY_HIGH,
} from "@rakazo/adapters";
import {
  findDecisionRecordings,
  recordDecisionCorpus,
  runDecisionCalibration,
} from "../decision-calibration.js";
import { buildDecisionRequests, loadDecisionCorpus } from "../decision-corpus.js";

const USAGE =
  "Usage: decision-calibration.ts [--recording=<file.json>] | --record=<new-file.json> [--model=<id>]";
/** Generous on purpose: a recording measures the answer, not the production budget. */
const RECORD_TIMEOUT_MS = 30_000;

/**
 * Offline by default. `--record` is the only path that reaches the network: it reads
 * the OpenRouter key from stdin, never from the environment or argv, and never writes it.
 */
async function main() {
  const args = process.argv.slice(2);
  const value = (name: string) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const unknown = args.filter((arg) => !/^--(recording|record|model)=./.test(arg));
  if (unknown.length) throw new Error(USAGE);
  const production = { target: TARGET_PROBABILITY_HIGH, verify: OUTCOME_PROBABILITY_LOW };
  const write = (text: string) => process.stdout.write(`${text}\n`);
  const record = value("record");
  if (record) {
    if (value("recording")) throw new Error(USAGE);
    const file = path.resolve(record);
    if (existsSync(file)) throw new Error(`Refusing to overwrite ${path.basename(file)}`);
    // Loading validates every case, including the `.test`-only URL rule, before any call.
    const built = await buildDecisionRequests(loadDecisionCorpus());
    const apiKey = await readKeyFromStdin();
    if (!apiKey) throw new Error("An OpenRouter key is required on stdin");
    const model = value("model");
    const provider = createDecisionProvider("openrouter", model ? { modelId: model } : {}, {
      apiKey,
    });
    write(`Recording ${built.length} cases, one request each...`);
    const recording = await recordDecisionCorpus(built, provider, {
      timeoutMs: RECORD_TIMEOUT_MS,
    });
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`, { flag: "wx" });
    const entries = Object.values(recording.cases);
    const cost = entries.reduce(
      (sum, entry) => sum + ("response" in entry ? (entry.response.usage?.cost ?? 0) : 0),
      0,
    );
    const unavailable = entries.filter((entry) => "unavailable" in entry).length;
    write(`Wrote ${path.basename(file)}: cost ${cost.toFixed(6)}, ${unavailable} unavailable.`);
    await runDecisionCalibration({ recordings: [file], production, write });
    return;
  }
  const recording = value("recording");
  await runDecisionCalibration({
    recordings: recording ? [path.resolve(recording)] : findDecisionRecordings(),
    production,
    write,
  });
}

/** Masked when stdin is a terminal; otherwise the first line of the piped stream. */
async function readKeyFromStdin(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let buffer = "";
    for await (const chunk of stdin) {
      buffer += String(chunk);
      if (buffer.includes("\n")) break;
    }
    stdin.destroy();
    return (buffer.split(/\r?\n/)[0] ?? "").trim();
  }
  process.stderr.write("OpenRouter key (input hidden): ");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let key = "";
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(key.trim());
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return done();
        if (char === "\u0003") return done(new Error("Cancelled"));
        if (char === "\u007f" || char === "\b") key = key.slice(0, -1);
        else key += char;
      }
    };
    stdin.on("data", onData);
    stdin.resume();
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
