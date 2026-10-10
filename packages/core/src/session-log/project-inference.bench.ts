import type { AgentHistoryTurn } from "@rakazo/contracts";
import { bench } from "vitest";
import { longSessionJsonl } from "./fixtures/long-session.js";
import { decodeEntries } from "./jsonl.js";
import { projectInferenceTurns } from "./project-inference.js";

const chain = decodeEntries(longSessionJsonl({ count: 500, compactionEvery: 500 }));
const options = { selfBotId: "bot_ada" };
let turns: AgentHistoryTurn[] = projectInferenceTurns(chain, options);
if (chain.length !== 500 || turns.length !== 144) {
  throw new Error(`expected 500 entries and 144 turns, got ${chain.length} and ${turns.length}`);
}

bench("projectInferenceTurns over 500 entries", () => {
  turns = projectInferenceTurns(chain, options);
});
