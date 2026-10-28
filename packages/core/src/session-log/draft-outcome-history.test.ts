import { APPROVAL_WAITING_TEXT, HELPER_STOPPED_FOR_PAUSE } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { linkEntries } from "./fixtures/read-fixture.js";
import { projectInferenceTurns } from "./project-inference.js";
import { projectThreadItems } from "./project-ui.js";
import { pendingPauseOfEffect } from "./run-fold.js";

const run = { botId: "bot_ada", runId: "run_1" };
const PAUSED = "paused: awaiting approval";

const call = (callId: string, name: string, input: object = {}) => ({
  ...run,
  type: "tool.call",
  payload: { callId, name, input: JSON.stringify(input) },
});
const result = (callId: string, output: string, replaces?: string) => ({
  ...run,
  type: "tool.result",
  payload: { callId, output, isError: false, artifactIds: [], ...(replaces ? { replaces } : {}) },
});
const requested = (effectId: string) => ({
  ...run,
  type: "effect.requested",
  payload: { effectId, effectKind: "GMAIL_SEND_EMAIL", proposal: {} },
});
const helperStopped = (callId: string, answer = APPROVAL_WAITING_TEXT) => ({
  ...run,
  type: "subagent",
  payload: {
    callId,
    sessionId: "ses_mailer",
    name: "mailer",
    task: "Mail Anna.",
    model: { provider: "openai-compatible", id: "offline" },
    status: "completed",
    result: answer,
    usage: { inputTokens: 0, outputTokens: 0 },
  },
});

/** A draft card raised by a call: the call, the card, and the pause the run waits in. */
const paused = (callId: string, effectId: string, to: string) => [
  call(callId, "GMAIL_SEND_EMAIL", { to }),
  requested(effectId),
  result(callId, PAUSED),
];

const outputsOf = (entries: ReturnType<typeof linkEntries>) =>
  projectInferenceTurns(entries, { selfBotId: "bot_ada" }).flatMap((turn) =>
    (turn.parts ?? []).flatMap((part) =>
      part.type === "toolCalls" ? part.calls.map((c) => [c.id, c.name, c.output]) : [],
    ),
  );

describe("a draft call's pause and its outcome", () => {
  it("reads the pause until the outcome is logged, then the outcome in its place", () => {
    const pending = paused("call_0", "effect_a", "anna@example.test");
    expect(outputsOf(linkEntries("p", pending))).toEqual([["call_0", "GMAIL_SEND_EMAIL", PAUSED]]);
    const ended = linkEntries("e", [...pending, result("call_0", "Sent.", "e-2")]);
    expect(outputsOf(ended)).toEqual([["call_0", "GMAIL_SEND_EMAIL", "Sent."]]);
  });

  it("gives each of two drafts that reuse a call id its own outcome", () => {
    const entries = linkEntries("r", [
      ...paused("call_0", "effect_a", "anna@example.test"),
      result("call_0", "Anna's mail was sent.", "r-2"),
      ...paused("call_0", "effect_b", "ben@example.test"),
      result("call_0", "Ben's mail was discarded.", "r-6"),
    ]);
    expect(outputsOf(entries).map(([, , output]) => output)).toEqual([
      "Anna's mail was sent.",
      "Ben's mail was discarded.",
    ]);
  });

  it("gives the outcome to the draft's call, not to an older call of the same id left open", () => {
    const entries = linkEntries("o", [
      call("call_0", "web_fetch", { url: "https://example.test" }),
      ...paused("call_0", "effect_a", "anna@example.test"),
      result("call_0", "Sent.", "o-3"),
    ]);
    expect(outputsOf(entries)).toEqual([["call_0", "GMAIL_SEND_EMAIL", "Sent."]]);
  });

  it("leaves a pause alone when only another call's result follows", () => {
    const entries = linkEntries("other", [
      ...paused("call_0", "effect_a", "anna@example.test"),
      call("call_1", "web_fetch"),
      result("call_1", "A page."),
    ]);
    expect(outputsOf(entries).map(([id, , output]) => [id, output])).toEqual([
      ["call_0", PAUSED],
      ["call_1", "A page."],
    ]);
  });

  it("drops an outcome whose pause is not in the log, so it answers no other call", () => {
    const entries = linkEntries("cut", [
      call("call_0", "web_fetch"),
      result("call_0", "A page."),
      result("call_0", "Sent.", "cut-9"),
    ]);
    expect(outputsOf(entries)).toEqual([["call_0", "web_fetch", "A page."]]);
  });

  it("gives a helper's draft outcome to the run_subagent call that was stopped for it", () => {
    const entries = linkEntries("h", [
      call("sub", "run_subagent", { name: "mailer" }),
      requested("effect_a"),
      helperStopped("sub"),
      result("sub", "Sent.", "h-2"),
    ]);
    expect(outputsOf(entries)).toEqual([["sub", "run_subagent", "Sent."]]);
  });
});

describe("a helper's draft in the thread", () => {
  const helperChain = (outcome: boolean) =>
    linkEntries("t", [
      call("sub", "run_subagent", { name: "mailer" }),
      requested("effect_a"),
      helperStopped("sub"),
      ...(outcome ? [result("sub", "Sent.", "t-2")] : []),
    ]);
  const helperStep = (entries: ReturnType<typeof linkEntries>) =>
    projectThreadItems(entries)
      .flatMap((item) => (item.kind === "message" ? item.blocks : []))
      .flatMap((block) => (block.kind === "steps" ? block.steps : []))
      .flatMap((step) => step.calls ?? [])
      .find((detail) => detail.name === "run_subagent");

  it("shows the draft card, and no helper card, before and after the outcome", () => {
    const kinds = (entries: ReturnType<typeof linkEntries>) =>
      projectThreadItems(entries).map((item) => item.kind);
    expect(kinds(helperChain(false))).toEqual(["message", "effect"]);
    expect(kinds(helperChain(true))).toEqual(["message", "effect"]);
  });

  it("keeps the helper's session on its step once the outcome replaced its answer", () => {
    expect(helperStep(helperChain(false))).toMatchObject({ sessionId: "ses_mailer" });
    expect(helperStep(helperChain(true))).toMatchObject({
      output: "Sent.",
      outcome: true,
      sessionId: "ses_mailer",
    });
  });
});

describe("pendingPauseOfEffect", () => {
  const pending = linkEntries("pending", paused("call_0", "effect_a", "anna@example.test"));

  it("names the call a card paused, and the pause, while the pause is the call's answer", () => {
    expect(pendingPauseOfEffect(pending, "effect_a")).toEqual({
      callId: "call_0",
      pauseId: "pending-2",
    });
  });

  it("names a helper stopped by the run's pause as well", () => {
    const entries = linkEntries("s", [
      call("sub", "run_subagent"),
      requested("effect_a"),
      helperStopped("sub", HELPER_STOPPED_FOR_PAUSE),
    ]);
    expect(pendingPauseOfEffect(entries, "effect_a")).toEqual({ callId: "sub", pauseId: "s-2" });
  });

  it("names the helper's stop when a helper raised the card", () => {
    const entries = linkEntries("h", [
      call("sub", "run_subagent"),
      requested("effect_a"),
      helperStopped("sub"),
    ]);
    expect(pendingPauseOfEffect(entries, "effect_a")).toEqual({ callId: "sub", pauseId: "h-2" });
  });

  it("names nothing once an outcome replaced the pause, so it is logged once", () => {
    const ended = linkEntries("ended", [
      ...paused("call_0", "effect_a", "anna@example.test"),
      result("call_0", "Sent.", "ended-2"),
    ]);
    expect(pendingPauseOfEffect(ended, "effect_a")).toBeUndefined();
  });

  it("names the pause that followed the card's first request, not a later request to show it again", () => {
    const again = linkEntries("again", [
      ...paused("call_0", "effect_a", "anna@example.test"),
      requested("effect_a"),
    ]);
    expect(pendingPauseOfEffect(again, "effect_a")).toMatchObject({ callId: "call_0" });
  });

  it("names nothing for a card whose call was never logged as paused, or an unknown card", () => {
    expect(pendingPauseOfEffect(linkEntries("n", [requested("effect_a")]), "effect_a")).toBe(
      undefined,
    );
    expect(pendingPauseOfEffect(pending, "effect_other")).toBeUndefined();
  });
});
