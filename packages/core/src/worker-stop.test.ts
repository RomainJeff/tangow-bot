import { describe, expect, it } from "vitest";
import { stopState } from "./worker-stop.js";

describe("stopState", () => {
  it("reads destroyed only once the lifecycle released the worker", () => {
    expect(stopState({ stopPhase: "unconfirmed", workerState: "released" })).toBe("destroyed");
    expect(stopState({ stopPhase: "process_ended", workerState: "releasing" })).toBe(
      "process_ended",
    );
    expect(stopState({ stopPhase: null, workerState: null })).toBe("none");
  });
});
