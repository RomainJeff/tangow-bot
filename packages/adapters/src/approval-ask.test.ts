import {
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH,
  SPAWN_BOT_PROMPT_MAX_LENGTH,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("binds the approval to its effect and redacts secrets", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", body: "token-secret" },
      ["token-secret"],
    );

    expect(block).toMatchObject({
      kind: "ask",
      approvalEffectId: "effect-1",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "always", label: "Always allow this tool" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(JSON.stringify(block)).not.toContain("token-secret");
  });

  it("bounds model-controlled summaries and details", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "destination.write",
      { title: "t".repeat(1_000), body: "b".repeat(10_000) },
      [],
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.text.length).toBeLessThanOrEqual(501);
    expect(block.detail?.length).toBeLessThanOrEqual(4_001);
  });

  it("includes an optional review reason as the first detail line", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      { to: "person@example.test", subject: "Hi" },
      [],
      { reviewReason: "Sends email outside the draft-only task." },
    );

    expect(block.kind).toBe("ask");
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail?.startsWith("Sends email outside the draft-only task.")).toBe(true);
    expect(block.detail).toContain("to: person@example.test");
  });

  it("uses a one-time create or cancel choice for a new security boundary", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "create_space",
      { name: "Customer support" },
      [],
    );

    expect(block).toMatchObject({
      kind: "ask",
      text: "Create space “Customer support”?",
      actions: [
        { id: "allow", label: "Create space", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
    });
    if (block.kind !== "ask") throw new Error("expected ask block");
    expect(block.detail).toContain("stay separate from other spaces");
  });
  describe("spawn_bot (CA4, CA23, CA24)", () => {
    const askBlock = (args: Record<string, unknown>, secrets: string[] = []) => {
      const block = buildApprovalAskBlock("effect-1", "spawn_bot", args, secrets);
      if (block.kind !== "ask") throw new Error("expected ask block");
      return block;
    };

    it("shows every field and offers Create bot or Cancel, never always", () => {
      const block = askBlock({
        name: "Veille",
        title: "Watches competitors",
        instructions: "Track them.",
        prompt: "Start today.",
        computer_mode: "dedicated",
      });

      expect(block.text).toBe("Create bot “Veille”?");
      expect(block.detail).toBe(
        [
          "Title: Watches competitors",
          "Computer: Private",
          "Instructions:",
          "  Track them.",
          "First message:",
          "  Start today.",
        ].join("\n"),
      );
      expect(block.approvalEffectId).toBe("effect-1");
      expect(block.actions).toEqual([
        { id: "allow", label: "Create bot", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ]);
      expect(block.detail).not.toMatch(/^title:/m);
    });

    it("omits empty fields and the default Team computer", () => {
      const block = askBlock({ name: "Veille", computer_mode: "team" });
      expect(block.detail).toBeUndefined();
      expect(askBlock({ name: "Veille", title: "T" }).detail).toBe("Title: T");
    });

    it("does not truncate values at their maximum sizes", () => {
      const block = askBlock({
        name: "n".repeat(BOT_NAME_MAX_LENGTH),
        title: "t".repeat(BOT_TITLE_MAX_LENGTH),
        instructions: "i".repeat(SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH),
        prompt: "p".repeat(SPAWN_BOT_PROMPT_MAX_LENGTH),
      });
      expect(block.text).toBe(`Create bot “${"n".repeat(BOT_NAME_MAX_LENGTH)}”?`);
      expect(block.detail).not.toContain("…");
      expect(block.detail).toContain("t".repeat(BOT_TITLE_MAX_LENGTH));
      expect(block.detail).toContain("i".repeat(SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH));
      expect(block.detail).toContain("p".repeat(SPAWN_BOT_PROMPT_MAX_LENGTH));
      expect(block.detail?.length).toBeLessThan(5_000);
    });

    it("shows the name as it is, without escaping", () => {
      expect(askBlock({ name: "Veille (EU)" }).text).toBe("Create bot “Veille (EU)”?");
    });

    it("indents every line of a multi-line value so a forged label cannot line up", () => {
      const block = askBlock({ name: "Veille", instructions: "Be nice.\nFirst message: none" });
      expect(block.detail).toBe("Instructions:\n  Be nice.\n  First message: none");
      for (const line of (block.detail ?? "").split("\n")) {
        if (line.startsWith("First message:")) throw new Error("forged label reached column 0");
      }
    });

    it("leaves masking to the executor instead of masking a second time", () => {
      const block = askBlock({ name: "Veille", instructions: "count 1 [redacted]" }, ["1"]);
      expect(block.detail).toBe("Instructions:\n  count 1 [redacted]");
    });
  });
});
