import { describe, expect, it } from "vitest";
import { selectTools } from "./helper-profile.js";

const CATALOG = [
  { name: "bash", where: "guest" as const },
  { name: "read", where: "guest" as const },
  { name: "remember", where: "controller" as const },
  { name: "computer_observe", where: "controller" as const },
  { name: "computer_click", where: "controller" as const },
  { name: "search_runs" },
];

const names = (rule: Parameters<typeof selectTools>[1]) =>
  selectTools(CATALOG, rule).map((tool) => tool.name);

describe("selectTools", () => {
  it("keeps only the harness's own tools without lists", () => {
    expect(names({})).toEqual(["bash", "read"]);
  });

  it("adds the tools allow names exactly or by prefix", () => {
    expect(names({ allow: ["search_runs", "computer_*"] })).toEqual([
      "bash",
      "read",
      "computer_observe",
      "computer_click",
      "search_runs",
    ]);
  });

  it("drops what block names, the harness's own tools included", () => {
    expect(names({ allow: ["*"], block: ["bash", "computer_click"] })).toEqual([
      "read",
      "remember",
      "computer_observe",
      "search_runs",
    ]);
  });
});
