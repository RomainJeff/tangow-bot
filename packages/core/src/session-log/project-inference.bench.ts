import { bench } from "vitest";
import { longSessionJsonl } from "./fixtures/long-session.js";
import { decodeEntries } from "./jsonl.js";
import { projectInferenceTurns } from "./project-inference.js";

const BUDGET_MS = 5;
const chain = decodeEntries(longSessionJsonl({ count: 1000, compactionEvery: 500 })).slice(500);
const options = { selfBotId: "bot_ada" };

const runsThatSpoke = new Set(
  chain.flatMap((entry) => (entry.type === "assistant.text" ? [entry.runId] : [])),
);
const expectedTurns =
  chain.filter((entry) => entry.type === "user.message" || entry.type === "compaction").length +
  runsThatSpoke.size;
let turns = projectInferenceTurns(chain, options);
if (chain[0]?.type !== "compaction" || chain.length !== 500 || turns.length !== expectedTurns) {
  throw new Error(
    `expected 500 entries from a compaction and ${expectedTurns} turns, got ${turns.length}`,
  );
}

const samples = Array.from({ length: 200 }, () => {
  const start = performance.now();
  turns = projectInferenceTurns(chain, options);
  return performance.now() - start;
}).sort((a, b) => a - b);
const median = samples[samples.length / 2] ?? Number.POSITIVE_INFINITY;
if (median > BUDGET_MS) {
  throw new Error(`median ${median.toFixed(3)} ms is over the ${BUDGET_MS} ms budget`);
}

bench("projectInferenceTurns over 500 entries", () => {
  turns = projectInferenceTurns(chain, options);
});
