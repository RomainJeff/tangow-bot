import { describe, expect, it } from "vitest";
import {
  approvedReplayCall,
  asSkillSaveRequest,
  creationCardError,
  creationGate,
  refusalLocks,
  runStance,
} from "./creation-gate.js";

const gateFor = (tool: string, trigger: string, exposed = false, sourceRole?: string) =>
  creationGate(tool, runStance({ trigger, sourceRole, exposed }));

describe("creationGate", () => {
  it("lets a clean user run create a routine and a skill directly", () => {
    expect(gateFor("schedule_create", "user")).toEqual({ kind: "direct" });
    expect(gateFor("skill_create", "user")).toEqual({ kind: "direct" });
    expect(gateFor("skill_delete", "user")).toEqual({ kind: "direct" });
  });

  it("asks the user on a card once the run read outside content", () => {
    expect(gateFor("schedule_create", "user", true)).toEqual({
      kind: "card",
      effectKind: "schedule_create",
      lockAfterRefusal: false,
    });
    expect(gateFor("skill_update", "user", true)).toEqual({
      kind: "card",
      effectKind: "skill_save",
      lockAfterRefusal: false,
    });
    expect(gateFor("skill_delete", "user", true)).toEqual({
      kind: "refuse",
      error: "Ask the user to delete this skill from their skills.",
    });
  });

  it("cards a routine nobody started, refuses one from a messaging contact", () => {
    for (const trigger of ["webhook", "bot_message", "routine"]) {
      expect(gateFor("schedule_create", trigger)).toEqual({
        kind: "card",
        effectKind: "schedule_create",
        lockAfterRefusal: true,
      });
    }
    expect(gateFor("schedule_create", "messaging")).toEqual({
      kind: "refuse",
      error: "Routines can only be created from the app.",
    });
  });

  it("saves no skill outside a run the user started", () => {
    for (const trigger of ["webhook", "bot_message", "routine", "messaging"]) {
      expect(gateFor("skill_create", trigger)).toEqual({
        kind: "refuse",
        error: "Skills are only saved while the user is in the conversation.",
      });
    }
  });

  it.each([
    ["the user's follow-up", "user", { kind: "direct" }],
    [
      "another bot's handoff",
      "bot",
      { kind: "card", effectKind: "schedule_create", lockAfterRefusal: true },
    ],
    [
      "a source message that is gone",
      undefined,
      { kind: "card", effectKind: "schedule_create", lockAfterRefusal: true },
    ],
  ])("treats a follow_up run answering %s by who wrote it", (_label, sourceRole, expected) => {
    expect(gateFor("schedule_create", "follow_up", false, sourceRole)).toEqual(expected);
  });

  it.each([
    ["user", "clean"],
    ["reaction", "clean"],
    ["skill", "clean"],
    ["follow_up", "unattended"],
    ["messaging", "messaging"],
    ["spawn", "unattended"],
    ["routine", "unattended"],
    ["resume", "unattended"],
    ["bot_message", "unattended"],
    ["webhook", "unattended"],
    ["message", "unattended"],
  ])("judges a clean %s run %s", (trigger, stance) => {
    expect(runStance({ trigger, exposed: false })).toBe(stance);
  });

  it("locks after a refusal only for a card shown in a run nobody started", () => {
    expect(refusalLocks("schedule_create", { trigger: "webhook" })).toBe(true);
    expect(refusalLocks("schedule_create", { trigger: "follow_up", sourceRole: "bot" })).toBe(true);
    expect(refusalLocks("schedule_create", { trigger: "user" })).toBe(false);
    expect(refusalLocks("schedule_create", { trigger: "follow_up", sourceRole: "user" })).toBe(
      false,
    );
    expect(refusalLocks("skill_create", { trigger: "user" })).toBe(false);
  });

  it("gates nothing else", () => {
    expect(gateFor("web_fetch", "webhook", true)).toBeUndefined();
    expect(gateFor("toString", "user")).toBeUndefined();
  });
});

describe("asSkillSaveRequest", () => {
  it("reads a stored folder save and refuses a malformed file", () => {
    const files = [
      { path: "scripts/run.sh", executable: true, text: "echo hi" },
      { path: "assets/logo.png", executable: false, base64: "iVBORw==" },
    ];
    expect(
      asSkillSaveRequest({ change: "created", name: "Deploy", content: "---", files }),
    ).toEqual({ change: "created", name: "Deploy", content: "---", files });
    expect(
      asSkillSaveRequest({
        change: "created",
        name: "Deploy",
        content: "---",
        files: [{ path: "a", executable: false, text: "x", base64: "eA==" }],
      }),
    ).toBe(undefined);
  });
});

describe("approvedReplayCall", () => {
  it("replays a folder save without its files, which the stored request keeps", () => {
    expect(
      approvedReplayCall("skill_save", {
        change: "created",
        name: "Deploy",
        content: "---",
        files: [{ path: "a.md", executable: false, text: "x" }],
      }),
    ).toEqual({ tool: "skill_create", args: { content: "---" } });
  });

  it("replays a skill card as the tool that writes its change", () => {
    expect(
      approvedReplayCall("skill_save", { change: "updated", name: "Coffee", content: "---" }),
    ).toEqual({ tool: "skill_update", args: { name: "Coffee", content: "---" } });
    expect(
      approvedReplayCall("skill_save", { change: "created", name: "Coffee", content: "---" }),
    ).toEqual({ tool: "skill_create", args: { content: "---" } });
    expect(approvedReplayCall("schedule_create", { name: "Daily" })).toEqual({
      tool: "schedule_create",
      args: { name: "Daily" },
    });
  });
});

describe("creationCardError", () => {
  it("refuses a skill folder too large to list on a card", () => {
    const files = (count: number, text = "x") =>
      Array.from({ length: count }, (_, index) => ({
        path: `references/${index}.md`,
        executable: false,
        text,
      }));
    const tooLarge =
      "This skill folder is too large to show the user for approval (at most 20 files, 64 KB of text and 1 MB in all). It can be saved directly in a conversation that has not read outside content.";
    expect(creationCardError("skill_create", { content: "---", files: files(19) })).toBe(undefined);
    expect(creationCardError("skill_create", { content: "---", files: files(20) })).toBe(tooLarge);
    expect(
      creationCardError("skill_update", { content: "abc", files: files(1, "x".repeat(65533)) }),
    ).toBe(undefined);
    expect(
      creationCardError("skill_update", { content: "abcd", files: files(1, "x".repeat(65533)) }),
    ).toBe(tooLarge);
    const binary = (bytes: number) => ({
      path: "assets/a.bin",
      executable: false,
      base64: Buffer.alloc(bytes).toString("base64"),
    });
    expect(creationCardError("skill_create", { content: "", files: [binary(1048576)] })).toBe(
      undefined,
    );
    expect(creationCardError("skill_create", { content: "x", files: [binary(1048576)] })).toBe(
      tooLarge,
    );
    expect(creationCardError("skill_create", { content: "", files: [{ path: "a" }] })).toBe(
      "This skill folder could not be read.",
    );
  });

  it("refuses a request a card could not show in full", () => {
    expect(creationCardError("schedule_create", { name: "Daily", prompt: "x".repeat(2000) })).toBe(
      undefined,
    );
    expect(creationCardError("schedule_create", { name: "Daily", prompt: "x".repeat(2001) })).toBe(
      "prompt must be at most 2000 characters for the user to confirm it.",
    );
    expect(creationCardError("skill_create", { content: "x".repeat(8001) })).toBe(
      "This skill must be at most 8000 characters for the user to confirm it.",
    );
  });
});
