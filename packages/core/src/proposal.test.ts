import { describe, expect, it } from "vitest";
import { routineConfirmationBlock } from "./proposal.js";

describe("routineConfirmationBlock", () => {
  const routine = {
    id: "routine-1",
    name: "Weekly offers",
    schedule: "Mondays at 09:00 Europe/Paris",
    prompt: "Summarize the new offers.",
    notify: false,
  };

  it("settles the card on the routine set up, opening on when it runs", () => {
    expect(routineConfirmationBlock("effect-1", routine)).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Mondays at 09:00 Europe/Paris",
      detail: [
        "name: Weekly offers",
        "schedule: Mondays at 09:00 Europe/Paris",
        "notify: no",
        "prompt:",
        "  Summarize the new offers.",
      ].join("\n"),
      status: "answered",
      actions: [
        { id: "allow", label: "Create routine", outcome: "created" },
        { id: "deny", label: "Not now", outcome: "cancelled" },
      ],
      routine: {
        name: "Weekly offers",
        schedule: "Mondays at 09:00 Europe/Paris",
        prompt: "Summarize the new offers.",
        notify: false,
      },
      created: { kind: "routine", id: "routine-1", label: "Weekly offers" },
      confirms: "created",
    });
  });
});
