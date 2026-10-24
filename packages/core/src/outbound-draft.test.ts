import { askDraftState } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { readDraft, withValueAt } from "./outbound-draft.js";

const base = { path: [2, "arguments", "body"], proposed: "Hello" };

describe("readDraft", () => {
  it.each([
    ["intended", { ...base, state: "pending" }, "pending"],
    ["intended", { ...base, state: "pending", failure: { reason: "Quota" } }, "pending"],
    ["approved", { ...base, state: "approved" }, "approved"],
    ["executing", { ...base, state: "approved" }, "approved"],
    ["completed", { ...base, state: "sent", at: "2026-10-24T10:00:00.000Z" }, "sent"],
    ["denied", { ...base, state: "discarded" }, "discarded"],
    ["denied", { ...base, state: "unsent" }, "unsent"],
  ])("reads a %s effect's %j", (status, draft, state) => {
    expect(readDraft(status, draft)?.state).toBe(state);
  });

  it.each([
    ["a plain effect", "intended", null],
    ["a status the state cannot have", "completed", { ...base, state: "approved" }],
    ["a pending draft once denied", "denied", { ...base, state: "pending" }],
    ["a sent draft with no time", "completed", { ...base, state: "sent" }],
    [
      "a failure outside a pending draft",
      "approved",
      { ...base, state: "approved", failure: { reason: "x" } },
    ],
    ["a path that is not one", "intended", { ...base, path: "body", state: "pending" }],
    ["an unknown state", "intended", { ...base, state: "superseded" }],
  ])("treats %s as no draft", (_, status, draft) => {
    expect(readDraft(status, draft)).toBe(undefined);
  });
});

describe("withValueAt", () => {
  const request = [
    "__marker",
    "mcp_execute_tool",
    { arguments: { tools: [{ arguments: { body: "Hi" } }] } },
  ];

  it("replaces only the value at the path, leaving the request it came from untouched", () => {
    const path = [2, "arguments", "tools", 0, "arguments", "body"];
    expect(withValueAt(request, path, "Edited")).toEqual([
      "__marker",
      "mcp_execute_tool",
      { arguments: { tools: [{ arguments: { body: "Edited" } }] } },
    ]);
    expect(request[2]).toEqual({ arguments: { tools: [{ arguments: { body: "Hi" } }] } });
  });

  it("finds no place where the path leads nowhere", () => {
    expect(withValueAt(request, [2, "arguments", "tools", 1, "arguments", "body"], "x")).toBe(
      undefined,
    );
    expect(withValueAt({ to: "a@example.com" }, ["body"], "x")).toBe(undefined);
  });
});

describe("askDraftState", () => {
  it.each([
    [{ status: "answered", answer: "deny" }, "discarded"],
    [{ status: "answered", answer: "allow", failed: true }, "not_sent"],
    [{ status: "answered", answer: "allow" }, "sending"],
  ] as const)("reads %j as %s", (card, state) => {
    expect(askDraftState(card)).toBe(state);
  });
});
