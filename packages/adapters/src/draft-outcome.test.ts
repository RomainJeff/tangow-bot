import type { SessionEntry } from "@tangow/contracts";
import { HELPER_STOPPED_FOR_PAUSE, SessionEntrySchema } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { DRAFT_DISCARDED_RESULT } from "./approval-effect.js";
import type { EndedDraftEffect } from "./draft-outcome.js";
import { endedDraftOutcomes } from "./draft-outcome.js";

const run = { botId: "bot_ada", runId: "run_1" };

function link(bodies: readonly object[]): SessionEntry[] {
  return bodies.map((body, seq) =>
    SessionEntrySchema.parse({
      id: `entry-${seq}`,
      sessionId: "ses_draft",
      seq,
      parentId: seq === 0 ? null : `entry-${seq - 1}`,
      ts: new Date(Date.UTC(2026, 9, 25, 9, 0, seq)).toISOString(),
      ...body,
    }),
  );
}

/** The log of a call that raised a draft card: the call, the card, and the pause. */
const pausedOn = (callId: string, effectId: string, output = "paused: awaiting approval") => [
  {
    ...run,
    type: "tool.call",
    payload: { callId, name: "GMAIL_SEND_EMAIL", input: "{}" },
  },
  {
    ...run,
    type: "effect.requested",
    payload: { effectId, effectKind: "GMAIL_SEND_EMAIL", proposal: {} },
  },
  {
    ...run,
    type: "tool.result",
    payload: { callId, output, isError: false, artifactIds: [] },
  },
];

const BINDING = { path: ["body"], proposed: "Hello." };
const effect = (
  id: string,
  status: string,
  draft: object | null,
  result: unknown = null,
  request: unknown = { body: "Hello, edited." },
): EndedDraftEffect => ({ id, kind: "GMAIL_SEND_EMAIL", status, request, result, draft });

describe("endedDraftOutcomes", () => {
  const SENT = { ok: true, note: "The user sent this message from the draft card." };

  it("reads each ended draft as its own call reads it when the bot issues it again", () => {
    const entries = link([
      ...pausedOn("call_a", "effect_a"),
      ...pausedOn("call_b", "effect_b"),
      ...pausedOn("call_c", "effect_c"),
    ]);
    expect(
      endedDraftOutcomes(
        [
          effect(
            "effect_a",
            "completed",
            { ...BINDING, state: "sent", at: "2026-10-25T09:00:00Z" },
            SENT,
          ),
          effect("effect_b", "denied", { ...BINDING, state: "discarded" }),
          effect("effect_c", "denied", { ...BINDING, state: "replaced" }),
        ],
        entries,
      ),
    ).toEqual([
      { callId: "call_a", pauseId: "entry-2", result: SENT },
      { callId: "call_b", pauseId: "entry-5", result: DRAFT_DISCARDED_RESULT },
      {
        callId: "call_c",
        pauseId: "entry-8",
        result: expect.objectContaining({
          ok: false,
          replaced: true,
          draft: { body: "Hello, edited.", editedByUser: ["body"] },
        }),
      },
    ]);
  });

  it("leaves a draft that is waiting, or shown again as Not sent, without an outcome", () => {
    const entries = link([...pausedOn("call_a", "effect_a"), ...pausedOn("call_b", "effect_b")]);
    expect(
      endedDraftOutcomes(
        [
          effect("effect_a", "intended", { ...BINDING, state: "pending" }),
          effect("effect_b", "intended", {
            ...BINDING,
            state: "pending",
            failure: { reason: "Check Gmail before trying again." },
          }),
        ],
        entries,
      ),
    ).toEqual([]);
  });

  it("tells the bot a send the run ended on may or may not have left", () => {
    const [outcome] = endedDraftOutcomes(
      [effect("effect_a", "denied", { ...BINDING, state: "unsent" })],
      link(pausedOn("call_a", "effect_a")),
    );
    expect(outcome).toEqual({
      callId: "call_a",
      pauseId: "entry-2",
      result: {
        error: expect.stringContaining("outcome is unknown"),
        uncertain: true,
      },
    });
  });

  it("gives a helper's draft the outcome on the run_subagent call it stopped", () => {
    const entries = link([
      { ...run, type: "tool.call", payload: { callId: "sub", name: "run_subagent", input: "{}" } },
      {
        ...run,
        type: "effect.requested",
        payload: { effectId: "effect_a", effectKind: "GMAIL_SEND_EMAIL", proposal: {} },
      },
      {
        ...run,
        type: "subagent",
        payload: {
          callId: "sub",
          name: "mailer",
          task: "Mail Anna.",
          model: { provider: "openai-compatible", id: "offline" },
          status: "completed",
          result: HELPER_STOPPED_FOR_PAUSE,
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      },
    ]);
    expect(
      endedDraftOutcomes(
        [effect("effect_a", "denied", { ...BINDING, state: "discarded" })],
        entries,
      ),
    ).toEqual([{ callId: "sub", pauseId: "entry-2", result: DRAFT_DISCARDED_RESULT }]);
  });

  it("lists a call once: its pause replaced by the outcome is not replaced again", () => {
    const ended = effect("effect_a", "denied", { ...BINDING, state: "discarded" });
    const first = link(pausedOn("call_a", "effect_a"));
    expect(endedDraftOutcomes([ended], first)).toHaveLength(1);
    const logged = link([
      ...pausedOn("call_a", "effect_a"),
      {
        ...run,
        type: "tool.result",
        payload: {
          callId: "call_a",
          output: JSON.stringify(DRAFT_DISCARDED_RESULT),
          isError: false,
          artifactIds: [],
          replaces: "entry-2",
        },
      },
    ]);
    expect(endedDraftOutcomes([ended], logged)).toEqual([]);
  });

  it("leaves an effect that is not a draft, and a draft whose call the log never paused", () => {
    const entries = link(pausedOn("call_a", "effect_a"));
    expect(
      endedDraftOutcomes(
        [
          effect("effect_a", "completed", null, { ok: true }),
          effect("effect_other", "denied", { ...BINDING, state: "discarded" }),
        ],
        entries,
      ),
    ).toEqual([]);
  });
});
