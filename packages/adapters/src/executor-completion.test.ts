import { describe, expect, it } from "vitest";
import {
  completionMarksUnread,
  completionMessageSegments,
  completionNotificationBody,
  notifiesUserOnRunEnd,
  routineRunHeadline,
  showsRoutineRunCard,
  subagentMarksUnread,
} from "./executor.js";
import { TOOL_FINAL_RESPONSE_FALLBACK } from "./user-progress.js";

describe("completionMessageSegments", () => {
  it("keeps visible tool activity without appending a generic completion claim", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Message bot", count: 1 }] }];
    expect(completionMessageSegments(steps)).toEqual(steps);
  });

  it("adds the missing-reply notice when a user is owed an answer after tool steps", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(completionMessageSegments(steps, { replyOwed: true })).toEqual([
      ...steps,
      { kind: "text", text: TOOL_FINAL_RESPONSE_FALLBACK },
    ]);
  });

  it("does not add the notice when a reply is not owed or one already exists", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(completionMessageSegments(steps, { replyOwed: false })).toEqual(steps);
    const answered = [...steps, { kind: "text" as const, text: "All done." }];
    expect(completionMessageSegments(answered, { replyOwed: true })).toEqual(answered);
  });

  it("keeps the last-resort fallback for a runtime that produced nothing", () => {
    expect(completionMessageSegments([])).toEqual([{ kind: "text", text: "done." }]);
  });

  it("allows a fully empty completion for silent bot-message wakes", () => {
    expect(completionMessageSegments([], { allowSilentEmpty: true })).toEqual([]);
  });

  it("drops narration after a successful group handoff", () => {
    expect(
      completionMessageSegments([{ kind: "text", text: "Research is checking this." }], {
        suppressOutput: true,
      }),
    ).toEqual([]);
  });

  it("uses a contextual fallback for a non-silent peer result", () => {
    expect(
      completionMessageSegments([], { emptyResponseText: "Update from Researcher: 42" }),
    ).toEqual([{ kind: "text", text: "Update from Researcher: 42" }]);
  });

  it("keeps a peer result visible when the runtime emitted only tool activity", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(
      completionMessageSegments(steps, { emptyResponseText: "Update from Researcher: 42" }),
    ).toEqual([...steps, { kind: "text", text: "Update from Researcher: 42" }]);
  });

  it("does not append fallback text to a tool-only FYI", () => {
    const steps = [{ kind: "steps" as const, steps: [{ label: "Read file", count: 1 }] }];
    expect(
      completionMessageSegments(steps, {
        allowSilentEmpty: true,
        emptyResponseText: "synthetic text",
      }),
    ).toEqual(steps);
  });

  it("normalizes a blank fallback", () => {
    expect(completionMessageSegments([], { emptyResponseText: "   " })).toEqual([
      { kind: "text", text: "done." },
    ]);
  });
});

describe("completionNotificationBody", () => {
  it("omits a body when only tool or step activity remains", () => {
    const steps = completionMessageSegments([
      { kind: "steps" as const, steps: [{ label: "Message bot", count: 1 }] },
    ]);
    expect(completionNotificationBody("", steps)).toBe("");
  });

  it("uses the empty-run text when that is all the run produced", () => {
    expect(completionNotificationBody("", completionMessageSegments([]))).toBe("done.");
  });
});

describe("notifiesUserOnRunEnd", () => {
  it("never pages the human for a sub-bot's delegated run", () => {
    // A sub-bot's delegated (bot_message) run reports back to the ordering bot and is hidden
    // from the user's thread, so a "finished"/"failed" push would be pure back-office noise.
    expect(notifiesUserOnRunEnd("bot_message", { isSubBot: true })).toBe(false);
  });

  it("pages the human for a top-level bot's relay of work it delegated", () => {
    // A top-level bot's `bot_message` run IS the user-facing relay of what a peer reported
    // (background-work-visibility CA5/CA6); it must notify like any other reply.
    expect(notifiesUserOnRunEnd("bot_message", { relaysToUser: true })).toBe(true);
    expect(notifiesUserOnRunEnd("bot_message", { isSubBot: false, relaysToUser: true })).toBe(true);
  });

  it("stays silent when a top-level bot answers a peer's own solicitation", () => {
    // The reply is returned to the peer, not written for the user; paging them about half a
    // conversation they never started is the same noise as showing it in their thread.
    expect(notifiesUserOnRunEnd("bot_message")).toBe(false);
    expect(notifiesUserOnRunEnd("bot_message", { relaysToUser: false })).toBe(false);
  });

  it("keeps user-initiated and top-level runs, including a top-level bot's routine", () => {
    expect(notifiesUserOnRunEnd("user")).toBe(true);
    expect(notifiesUserOnRunEnd("messaging")).toBe(true);
    // Orchestrator (no parent): its routine is a user-facing brief and still notifies.
    expect(notifiesUserOnRunEnd("routine")).toBe(true);
    expect(notifiesUserOnRunEnd("routine", { isSubBot: false })).toBe(true);
  });

  it("silences a routine card run by default but keeps direct conversation with the user", () => {
    // A routine card run (a sub-bot's routine, or any inbound wake) reports through its run
    // card; any closing text it emits must not page the user unless the routine's own notify
    // toggle is on. Direct conversation (user/messaging) still notifies regardless.
    expect(notifiesUserOnRunEnd("routine", { isSubBot: true, routineCard: true })).toBe(false);
    expect(notifiesUserOnRunEnd("webhook", { routineCard: true, notify: false })).toBe(false);
    expect(notifiesUserOnRunEnd("user", { isSubBot: true })).toBe(true);
    expect(notifiesUserOnRunEnd("messaging", { isSubBot: true })).toBe(true);
    // A bare inbound delivery with no routine is an ordinary reply.
    expect(notifiesUserOnRunEnd("webhook")).toBe(true);
  });

  it("pages the human for a routine card run the user explicitly subscribed to (notify: true)", () => {
    // The per-routine notify toggle is the explicit exception: the user chose to hear from
    // this specific routine every time, independent of Claudius's own triage.
    expect(notifiesUserOnRunEnd("routine", { routineCard: true, notify: true })).toBe(true);
    expect(notifiesUserOnRunEnd("webhook", { routineCard: true, notify: true })).toBe(true);
  });
});

describe("showsRoutineRunCard", () => {
  it("cards every inbound routine wake and a sub-bot's scheduled routine", () => {
    expect(showsRoutineRunCard({ trigger: "webhook", routineId: "routine-1" }, false)).toBe(true);
    expect(showsRoutineRunCard({ trigger: "webhook", routineId: "routine-1" }, true)).toBe(true);
    expect(showsRoutineRunCard({ trigger: "routine", routineId: "routine-1" }, true)).toBe(true);
  });

  it("keeps a top-level scheduled routine and a bare delivery as normal replies", () => {
    expect(showsRoutineRunCard({ trigger: "routine", routineId: "routine-1" }, false)).toBe(false);
    expect(showsRoutineRunCard({ trigger: "webhook", routineId: null }, false)).toBe(false);
    expect(showsRoutineRunCard({ trigger: "user", routineId: null }, true)).toBe(false);
  });
});

describe("routineRunHeadline", () => {
  it("takes the first non-empty line of the digest", () => {
    expect(routineRunHeadline("Inbox is clear.\n\nChecked 12 threads.")).toBe("Inbox is clear.");
  });

  it("skips leading blank lines", () => {
    expect(routineRunHeadline("\n\n  Two invoices need approval.\nDetails below.")).toBe(
      "Two invoices need approval.",
    );
  });

  it("returns undefined for a fully empty digest", () => {
    expect(routineRunHeadline("")).toBeUndefined();
    expect(routineRunHeadline("\n\n   \n")).toBeUndefined();
  });

  it("truncates a long line to ~120 chars with an ellipsis", () => {
    const line = "x".repeat(200);
    const headline = routineRunHeadline(line);
    expect(headline?.endsWith("…")).toBe(true);
    expect(headline?.length).toBe(121);
  });

  it("is a pure, deterministic slice — never a model call", () => {
    // Same input always yields the same headline; no randomness, no async, no LLM round trip.
    expect(routineRunHeadline("Same digest every time.")).toBe(
      routineRunHeadline("Same digest every time."),
    );
  });
});

describe("completionMarksUnread", () => {
  it("ignores silent routine activity but keeps routine comments and manual replies unread", () => {
    expect(completionMarksUnread("routine", "")).toBe(false);
    expect(completionMarksUnread("routine", "Daily report ready")).toBe(true);
    expect(completionMarksUnread("user", "")).toBe(true);
    // An inbound routine wake reports through its card like any background routine.
    expect(completionMarksUnread("webhook", "", true)).toBe(false);
    expect(completionMarksUnread("webhook", "Deploy is green", true)).toBe(true);
    expect(completionMarksUnread("webhook", "")).toBe(true);
  });

  it("keeps empty-run done. fallback unread and notifying", () => {
    const segments = completionMessageSegments([]);
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([{ kind: "text", text: "done." }]);
    expect(text).toBe("done.");
    expect(completionMarksUnread("routine", text)).toBe(true);
    expect(completionMarksUnread("user", text)).toBe(true);
  });

  it("does not invent done. unread for a routine whose only activity is a completed subagent", () => {
    // Terminal subagent rows are published separately; skipEmptyFallback mirrors that durable
    // activity so completion does not synthesize "done." (which would mark unread + notify).
    const segments = completionMessageSegments([], { skipEmptyFallback: true });
    const text = completionNotificationBody("", segments);
    expect(segments).toEqual([]);
    expect(text).toBe("");
    expect(completionMarksUnread("routine", text)).toBe(false);
    expect(completionMarksUnread("user", text)).toBe(true);
  });
});

describe("subagentMarksUnread", () => {
  it("ignores completed routine activity but preserves failures and manual activity", () => {
    expect(subagentMarksUnread("routine", "completed")).toBe(false);
    expect(subagentMarksUnread("routine", "failed")).toBe(true);
    expect(subagentMarksUnread("user", "completed")).toBe(true);
  });
});
