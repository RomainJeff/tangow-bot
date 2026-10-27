import { builtinAgentTools } from "@rakazo/adapters";
import { nativeToolsForHarness } from "@rakazo/adapters/runtime-worker";
import type { HelperProfile } from "@rakazo/core";
import { selectTools } from "@rakazo/core";
import { expect, it } from "vitest";
import { researcher, screenOperator } from "./helper-profiles.fixture.js";

/** What a Pi native bot can be offered: its harness's own tools, then Rakazo's. */
const CATALOG = [
  ...nativeToolsForHarness("pi-native").map(({ name }) => ({ name, where: "guest" as const })),
  ...builtinAgentTools.map(({ name }) => ({ name, where: "controller" as const })),
];
const names = (rule: Pick<HelperProfile, "allow" | "block">) =>
  selectTools(CATALOG, rule).map((tool) => tool.name);

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
  expect(names(screenOperator)).toEqual([
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
  ]);
});
