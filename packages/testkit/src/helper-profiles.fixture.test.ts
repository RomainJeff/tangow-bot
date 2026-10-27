import { builtinAgentTools, computerExecTool } from "@rakazo/adapters";
import { nativeToolsForHarness } from "@rakazo/adapters/runtime-worker";
import type { HelperProfile } from "@rakazo/core";
import { HELPER_PROFILES, selectTools } from "@rakazo/core";
import { expect, it } from "vitest";
import { researcher, screenOperator } from "./helper-profiles.fixture.js";

/** What a Pi native bot on a worker can be offered: its harness's own tools, then Rakazo's. */
const CATALOG = [
  ...nativeToolsForHarness("pi-native").map(({ name }) => ({ name, where: "guest" as const })),
  ...[...builtinAgentTools, computerExecTool].map(({ name }) => ({
    name,
    where: "controller" as const,
  })),
];
const names = (rule: Pick<HelperProfile, "allow" | "block">) =>
  selectTools(CATALOG, rule).map((tool) => tool.name);
const COMPUTER_AND_BROWSER = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "tool_search",
  "search_runs",
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "browser_run",
  "computer_exec",
];

it("grants each example profile its literal tools", () => {
  expect(names(researcher)).toEqual([
    "read",
    "grep",
    "find",
    "ls",
    "tool_search",
    "search_runs",
    "web_search",
    "web_fetch",
  ]);
  expect(names(screenOperator)).toEqual(COMPUTER_AND_BROWSER);
});

it("grants the managed computer-use helper the computer, the browser and past runs, and holds the computer", () => {
  const computerUse = HELPER_PROFILES.find((profile) => profile.name === "computer-use");
  expect(computerUse && names(computerUse)).toEqual(COMPUTER_AND_BROWSER);
  expect(computerUse?.exclusive).toBe("computer");
});
