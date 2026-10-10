import { describe, expect, it } from "vitest";
import { serverError } from "./server-error";
import { undoOutcome } from "./skill-versions";

describe("undoOutcome", () => {
  it("returns the id the skill has after the undo", async () => {
    expect(
      await undoOutcome(async () => ({ kind: "restored", skillId: "user:old", name: "Old" })),
    ).toEqual({ kind: "restored", skillId: "user:old" });
  });

  it("reports a creation undone as trashed", async () => {
    expect(await undoOutcome(async () => ({ kind: "trashed" }))).toEqual({ kind: "trashed" });
  });

  it("carries the server's sentence when the skill changed meanwhile", async () => {
    const message = "This skill changed. Reload and try again.";
    expect(
      await undoOutcome(async () => {
        throw serverError(message);
      }),
    ).toEqual({ kind: "refused", message });
  });

  it("has no sentence when the call never got an answer", async () => {
    expect(
      await undoOutcome(async () => {
        throw new Error("Network request failed");
      }),
    ).toEqual({ kind: "refused", message: "" });
  });
});
