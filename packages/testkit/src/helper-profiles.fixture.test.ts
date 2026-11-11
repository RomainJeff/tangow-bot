import { builtinAgentTools, computerExecTool } from "@tangow/adapters";
import { nativeToolsForHarness } from "@tangow/adapters/runtime-worker";
import type { HelperProfile } from "@tangow/core";
import { delegatedTools, HELPER_PROFILES, MAIN_BOT_BLOCKED_TOOLS, selectTools } from "@tangow/core";
import { expect, it } from "vitest";
import { researcher, screenOperator } from "./helper-profiles.fixture.js";

/** What a Pi native bot on a worker can be offered: its harness's own tools, then Tangow's. */
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
  "ask_parent",
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

it("grants the managed computer-use helper the computer, the browser and past runs", () => {
  const computerUse = HELPER_PROFILES.find((profile) => profile.name === "computer-use");
  expect(computerUse && names(computerUse)).toEqual([
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
    "open_path",
    "launch_app",
    "ask_parent",
    "computer_exec",
  ]);
});

it("hands the computer and the browser to computer-use", () => {
  expect(delegatedTools(CATALOG, MAIN_BOT_BLOCKED_TOOLS, HELPER_PROFILES)).toEqual([
    "computer_observe",
    "computer_act",
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    "browser_run",
    "open_path",
    "launch_app",
    "computer_exec",
  ]);
});
