import { appendToolStep } from "@rakazo/core";
import { describe, expect, it } from "vitest";

describe("appendToolStep", () => {
  it("merges consecutive calls of the same tool and keeps every detail", () => {
    let steps = appendToolStep([], "read_file", { name: "read_file", input: "a", output: "1" });
    steps = appendToolStep(steps, "read_file", { name: "read_file", input: "b", output: "2" });
    steps = appendToolStep(steps, "web_search", { name: "web_search", input: "c", output: "3" });
    expect(steps).toHaveLength(2);
    expect(steps[0]?.count).toBe(2);
    expect(steps[0]?.calls?.map((call) => call.input)).toEqual(["a", "b"]);
    expect(steps[1]?.calls).toHaveLength(1);
  });

  it("stays detail-free when no call is provided", () => {
    const steps = appendToolStep(appendToolStep([], "read_file"), "read_file");
    expect(steps).toEqual([{ label: "Read file", count: 2 }]);
  });
});
