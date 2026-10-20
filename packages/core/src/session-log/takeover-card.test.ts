import type { ThreadItem } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { latestTakeoverItemId } from "./takeover-card.js";

function message(id: string, runId: string, blocks: unknown[]): ThreadItem {
  return { kind: "message", role: "bot", id, runId, blocks } as unknown as ThreadItem;
}

const needsYou = { kind: "computer", state: "Needs you", text: "Sign in to continue" };

describe("latestTakeoverItemId", () => {
  it("ignores a person's own message, even one that carries a run", () => {
    const userItem = { kind: "message", role: "user", id: "mine", runId: "run-1" } as unknown;
    expect(
      latestTakeoverItemId([userItem as ThreadItem], [{ id: "run-1", status: "waiting_takeover" }]),
    ).toBeNull();
  });

  it("finds the newest Needs you card of a run waiting for the screen", () => {
    expect(
      latestTakeoverItemId(
        [
          message("old", "run-1", [needsYou]),
          message("narration", "run-1", [{ kind: "text", text: "Opening the page" }]),
          message("card", "run-1", [{ kind: "steps" }, needsYou]),
        ],
        [{ id: "run-1", status: "waiting_takeover" }],
      ),
    ).toBe("card");
  });

  it("ignores cards once the run is no longer waiting for the screen", () => {
    expect(
      latestTakeoverItemId(
        [message("card", "run-1", [needsYou])],
        [{ id: "run-1", status: "running" }],
      ),
    ).toBeNull();
  });

  it("ignores a card from a run that is waiting for input, not the screen", () => {
    expect(
      latestTakeoverItemId(
        [message("card", "run-2", [needsYou]), message("ask", "run-1", [{ kind: "ask" }])],
        [
          { id: "run-1", status: "waiting_input" },
          { id: "run-2", status: "running" },
        ],
      ),
    ).toBeNull();
  });
});
