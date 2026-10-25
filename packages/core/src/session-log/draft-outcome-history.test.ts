import { describe, expect, it } from "vitest";
import { linkEntries } from "./fixtures/read-fixture.js";
import { projectInferenceTurns } from "./project-inference.js";
import { pausedCallOfEffect } from "./run-fold.js";

const run = { botId: "bot_ada", runId: "run_1" };
const PAUSED = "paused: awaiting approval";

const sendCall = (callId: string, to: string) => ({
  ...run,
  type: "tool.call",
  payload: { callId, name: "GMAIL_SEND_EMAIL", input: JSON.stringify({ to }) },
});
const result = (callId: string, output: string) => ({
  ...run,
  type: "tool.result",
  payload: { callId, output, isError: false, artifactIds: [] },
});
const requested = (effectId: string) => ({
  ...run,
  type: "effect.requested",
  payload: { effectId, effectKind: "GMAIL_SEND_EMAIL", proposal: {} },
});

/** A draft card raised by a call: the call, the card, and the pause the run waits in. */
const paused = (callId: string, effectId: string, to: string) => [
  sendCall(callId, to),
  requested(effectId),
  result(callId, PAUSED),
];

const outputsOf = (entries: ReturnType<typeof linkEntries>) =>
  projectInferenceTurns(entries, { selfBotId: "bot_ada" }).flatMap((turn) =>
    (turn.parts ?? []).flatMap((part) =>
      part.type === "toolCalls" ? part.calls.map((call) => [call.id, call.output]) : [],
    ),
  );

describe("a draft call's pause and its outcome", () => {
  it("reads the pause until the card's outcome is logged, then the outcome in its place", () => {
    const pending = paused("call_0", "effect_a", "anna@example.test");
    expect(outputsOf(linkEntries("pending", pending))).toEqual([["call_0", PAUSED]]);

    const ended = [...pending, result("call_0", '{"ok":true,"note":"Sent."}')];
    expect(outputsOf(linkEntries("ended", ended))).toEqual([
      ["call_0", '{"ok":true,"note":"Sent."}'],
    ]);
  });

  it("gives each of two drafts that reuse a call id its own outcome", () => {
    const entries = linkEntries("reused", [
      ...paused("call_0", "effect_a", "anna@example.test"),
      result("call_0", "Anna's mail was sent."),
      ...paused("call_0", "effect_b", "ben@example.test"),
      result("call_0", "Ben's mail was discarded."),
    ]);
    expect(outputsOf(entries)).toEqual([
      ["call_0", "Anna's mail was sent."],
      ["call_0", "Ben's mail was discarded."],
    ]);
  });

  it("leaves a pause alone when only another call's result follows", () => {
    const entries = linkEntries("other", [
      ...paused("call_0", "effect_a", "anna@example.test"),
      sendCall("call_1", "ben@example.test"),
      result("call_1", "Ben's mail went out."),
    ]);
    expect(outputsOf(entries)).toEqual([
      ["call_0", PAUSED],
      ["call_1", "Ben's mail went out."],
    ]);
  });
});

describe("pausedCallOfEffect", () => {
  const pendingChain = linkEntries("pending", paused("call_0", "effect_a", "anna@example.test"));

  it("names the call a card paused while its pause is the call's answer", () => {
    expect(pausedCallOfEffect(pendingChain, "effect_a")).toBe("call_0");
  });

  it("names nothing once the outcome replaced the pause, so it is logged once", () => {
    const ended = linkEntries("ended", [
      ...paused("call_0", "effect_a", "anna@example.test"),
      result("call_0", "Sent."),
    ]);
    expect(pausedCallOfEffect(ended, "effect_a")).toBeUndefined();
  });

  it("names the pause that followed the card's first request, not a later request to show it again", () => {
    const shownAgain = linkEntries("again", [
      ...paused("call_0", "effect_a", "anna@example.test"),
      requested("effect_a"),
    ]);
    expect(pausedCallOfEffect(shownAgain, "effect_a")).toBe("call_0");
  });

  it("names nothing for a card whose call was never logged as paused", () => {
    expect(pausedCallOfEffect(linkEntries("none", [requested("effect_a")]), "effect_a")).toBe(
      undefined,
    );
    expect(pausedCallOfEffect(pendingChain, "effect_other")).toBeUndefined();
  });
});
