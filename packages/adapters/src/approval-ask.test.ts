import type { AskDraft } from "@rakazo/contracts";
import {
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH,
  SPAWN_BOT_PROMPT_MAX_LENGTH,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { approvalPushBody, buildApprovalAskBlock } from "./approval-ask.js";

describe("buildApprovalAskBlock", () => {
  it("shows a proposed routine on the routine card, a forged line kept inside the prompt", () => {
    const block = buildApprovalAskBlock("effect-1", "schedule_create", {}, [], {
      routineCard: {
        routine: {
          name: "Daily digest",
          schedule: "Every day at 09:00 UTC",
          prompt: "Read my mail\nnotify: false",
          notify: true,
        },
      },
    });
    expect(block).toMatchObject({
      proposal: "routine",
      text: "Create routine?",
      detail:
        "name: Daily digest\nschedule: Every day at 09:00 UTC\nnotify: yes\nprompt:\n  Read my mail\n  notify: false",
      actions: [
        { id: "allow", label: "Create routine", outcome: "created" },
        { id: "deny", label: "Not now", outcome: "cancelled" },
      ],
    });
  });

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

    it("names the run's owner, the only person who can edit the card", () => {
      const block = buildApprovalAskBlock("effect-1", "spawn_bot", { name: "Veille" }, [], {
        runUserId: "user-1",
      });
      expect(block.kind === "ask" && block.spawnBot?.ownerUserId).toBe("user-1");
    });

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

  it("names the sending account on a draft, before the recipients", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      { recipient_email: "marie@example.test", body: "Hi", from_email: "alias@corp.example" },
      [],
      {
        draft: {
          app: { name: "Gmail", logo: null, account: "alias@corp.example" },
          recipients: [{ role: "to", address: "marie@example.test" }],
          body: "Hi",
        },
      },
    );
    expect(block).toMatchObject({
      detail: "from: alias@corp.example\nto: marie@example.test\nbody:\n  Hi",
    });
  });

  it.each(["\v", "\f", "\u0085"])("indents the line break %j inside a value", (lineBreak) => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.test", body: `Hi${lineBreak}to: b@example.test` },
      [],
      { unreadable: true },
    );
    expect(block).toMatchObject({ detail: "to: a@example.test\nbody: Hi\n  to: b@example.test" });
  });

  it("indents every kind of line break inside a draft's subject and body", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      { recipient_email: "marie@example.test", body: "Hi" },
      [],
      {
        draft: {
          app: { name: "Gmail", logo: null },
          recipients: [{ role: "to", address: "marie@example.test" }],
          subject: "Re\rbcc: a@example.test",
          body: "Hi\r\nbcc: b@example.test\u2028to: c@example.test",
        },
      },
    );
    expect(block).toMatchObject({
      detail:
        "to: marie@example.test\nsubject: Re\n  bcc: a@example.test\nbody:\n  Hi\n  bcc: b@example.test\n  to: c@example.test",
    });
  });

  it("shows a draft in full, every recipient by role, and offers Send or Discard", () => {
    const body = `Hello Marie,\nbcc: nobody@example.test\n${"x".repeat(5_000)}`;
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      { recipient_email: "marie@example.test", body },
      ["sk-secret-1234"],
      {
        draft: {
          app: { name: "Gmail", logo: null },
          recipients: [
            { role: "to", address: "marie@example.test" },
            { role: "to", address: "paul@example.test" },
            { role: "bcc", address: "boss@example.test" },
          ],
          subject: "Key sk-secret-1234",
          body,
        },
      },
    );
    expect(block).toMatchObject({
      text: "Review before GMAIL_SEND_EMAIL → marie@example.test",
      detail: `to: marie@example.test, paul@example.test\nbcc: boss@example.test\nsubject: Key [redacted]\nbody:\n  Hello Marie,\n  bcc: nobody@example.test\n  ${"x".repeat(5_000)}`,
      actions: [
        { id: "allow", label: "Send" },
        { id: "deny", label: "Discard" },
      ],
      draft: { subject: "Key [redacted]", body },
    });
  });

  it("names the run's owner on a draft, the one person who may send it", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      { recipient_email: "bo@example.test", body: "Hi" },
      [],
      {
        runUserId: "user-ana",
        runUserName: "Ana Lima",
        draft: {
          app: { name: "Gmail", logo: null },
          recipients: [{ role: "to", address: "bo@example.test" }],
          body: "Hi",
        },
      },
    );
    expect(block).toMatchObject({ draft: { owner: { userId: "user-ana", name: "Ana Lima" } } });
  });

  it("shows every argument of a send it cannot read, and offers no always-allow", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.test", body: "Hi", notes: "evil@example.test", cc: ["b@example.test"] },
      [],
      { unreadable: true },
    );
    expect(block).toMatchObject({
      detail: 'to: a@example.test\ncc: ["b@example.test"]\nbody: Hi\nnotes: evil@example.test',
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    });
  });

  it("indents the lines of a multi-line value so none passes for a field label", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      { to: "a@example.test", body: "Hello\nrecipient_email: someone@example.test" },
      [],
      { unreadable: true },
    );
    expect(block).toMatchObject({
      detail: "to: a@example.test\nbody: Hello\n  recipient_email: someone@example.test",
    });
  });

  it("shows every argument of a send it cannot read, and marks a long value as cut", () => {
    const args = {
      ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`note${i}`, "n".repeat(490)])),
      body: "b".repeat(5_000),
      bcc: ["hidden@example.test"],
      is_html: true,
      attachment: { name: "a.pdf" },
    };
    const block = buildApprovalAskBlock("effect-1", "GMAIL_SEND_EMAIL", args, [], {
      unreadable: true,
    });
    const lines = block.kind === "ask" ? (block.detail ?? "").split("\n") : [];
    expect(lines.map((line) => line.split(":")[0])).toEqual([
      "bcc",
      ...Array.from({ length: 8 }, (_, i) => `note${i}`),
      "is_html",
      "attachment",
      "body",
    ]);
    expect(lines.at(-1)?.endsWith("…")).toBe(true);
  });

  it("never shortens a long recipient list on a send it cannot read", () => {
    const bcc = Array.from({ length: 100 }, (_, index) => `person${index}@example.test`);
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      { body: "x".repeat(5_000), bcc, to: "a@example.test", notes: "kept" },
      [],
      { unreadable: true },
    );
    expect(block).toMatchObject({
      detail: `bcc: ${JSON.stringify(bcc)}\nto: a@example.test\nnotes: kept\nbody: ${"x".repeat(1_000)}…`,
    });
  });

  it("keeps every recipient visible on a send it cannot read when the body is long", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "GMAIL_SEND_EMAIL",
      {
        to: "a@example.test",
        body: "x".repeat(5_000),
        bcc: ["hidden@example.test"],
        notes: "y".repeat(5_000),
        subject: "Hi",
      },
      [],
      { unreadable: true },
    );
    expect(block).toMatchObject({
      detail: `to: a@example.test\nbcc: ["hidden@example.test"]\nsubject: Hi\nbody: ${"x".repeat(1_000)}…\nnotes: ${"y".repeat(1_000)}…`,
    });
  });
});

describe("approvalPushBody", () => {
  const mail: AskDraft = {
    app: { name: "Gmail", logo: null },
    recipients: [{ role: "to", address: "someone@example.com" }],
    subject: "Test A",
    body: "Hello",
  };
  const push = (draft?: AskDraft, secrets: string[] = []) =>
    approvalPushBody(
      buildApprovalAskBlock("effect-1", "GMAIL_SEND_EMAIL", { tools: [] }, secrets, { draft }),
    );

  it("names a mail's app, subject and recipient", () => {
    expect(push(mail)).toBe("Gmail: Test A to someone@example.com");
  });

  it("names a chat message's person, and a channel with its #", () => {
    const chat: AskDraft = {
      app: { name: "Slack", logo: null },
      recipients: [{ role: "to", address: "D0MARIE" }],
      body: "Thursday instead?",
    };
    expect(
      push({ ...chat, conversation: { kind: "person", name: "Marie Dupont", handle: "marie" } }),
    ).toBe("Slack: Thursday instead? to Marie Dupont");
    expect(push({ ...chat, conversation: { kind: "channel", name: "general" } })).toBe(
      "Slack: Thursday instead? to #general",
    );
  });

  it("falls back to the first line of the text when there is no subject", () => {
    expect(push({ ...mail, subject: undefined, body: "\n Hi Marie,\nSee you." })).toBe(
      "Gmail: Hi Marie, to someone@example.com",
    );
  });

  it("leaves out the line when the draft has none", () => {
    expect(push({ ...mail, subject: undefined, body: "" })).toBe("Gmail: to someone@example.com");
  });

  it("keeps a secret in the subject masked", () => {
    expect(push({ ...mail, subject: "Key sk-secret-1234" }, ["sk-secret-1234"])).toBe(
      "Gmail: Key [redacted] to someone@example.com",
    );
  });

  it("uses the card's own text for a direct tool", () => {
    const block = buildApprovalAskBlock(
      "effect-1",
      "gmail_send_email",
      {
        to: "person@example.test",
      },
      [],
    );
    expect(approvalPushBody(block)).toBe(block.text);
  });
});
