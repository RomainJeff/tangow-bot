import type { ReplyFinal, WorkerEventV1, WorkerReplyV1 } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { createSessionInbox, type InboxHandler } from "./inbox.js";

const worker = { runId: "run_1", attemptId: "attempt_1", fence: 2 };
const call = { type: "tool.call", agent: "root", callId: "c1", name: "bash", args: {} } as const;
const frame = (seq: number, identity = worker): WorkerEventV1 => ({
  version: 2,
  kind: "worker.event",
  worker: identity,
  payload: { seq, body: call },
});

function harness(handle: InboxHandler, limits = { inflightFrames: 32, replyCache: 64 }) {
  const replies: Array<WorkerReplyV1["payload"]> = [];
  const inbox = createSessionInbox(worker, handle, limits);
  inbox.attach((reply) => replies.push(reply.payload));
  return { inbox, replies };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSessionInbox", () => {
  it("decides a resent frame once and answers each resend with the same reply", async () => {
    let decide: (final: ReplyFinal) => void = () => undefined;
    let decisions = 0;
    const { inbox, replies } = harness(() => {
      decisions += 1;
      return new Promise((resolve) => (decide = resolve));
    });

    expect(inbox.accept(frame(1))).toEqual({ ok: true });
    await tick();
    expect(inbox.accept(frame(1))).toEqual({ ok: true });
    decide({ type: "tool.result", output: "ok" });
    await tick();
    const reconnected: Array<WorkerReplyV1["payload"]> = [];
    inbox.attach((reply) => reconnected.push(reply.payload));
    inbox.accept(frame(1));

    const answer = { re: 1, part: 0, body: { type: "tool.result", output: "ok" } };
    expect(decisions).toBe(1);
    expect(replies).toEqual([answer]);
    expect(reconnected).toEqual([answer]);
  });

  it("replays every streamed part to a resent frame", async () => {
    const { inbox, replies } = harness(async (_seq, _body, part) => {
      part({ type: "model.event", event: { type: "text_delta", contentIndex: 0, delta: "hi" } });
      return { type: "model.end" };
    });

    inbox.accept(frame(1));
    await tick();
    inbox.accept(frame(1));

    const streamed = [
      {
        re: 1,
        part: 0,
        body: { type: "model.event", event: { type: "text_delta", contentIndex: 0, delta: "hi" } },
      },
      { re: 1, part: 1, body: { type: "model.end" } },
    ];
    expect(replies).toEqual([...streamed, ...streamed]);
  });

  it("settles a failed decision as an error the guest can raise", async () => {
    const { inbox, replies } = harness(async () => {
      throw new Error("connector down");
    });

    inbox.accept(frame(1));
    await tick();

    expect(replies).toEqual([
      { re: 1, part: 0, body: { type: "error", message: "connector down" } },
    ]);
  });

  it.each([
    [
      "another attempt's frame",
      (inbox: ReturnType<typeof harness>["inbox"]) =>
        inbox.accept(frame(1, { ...worker, fence: 1 })),
      1,
      "identity",
    ],
    [
      "a frame skipping a number",
      (inbox: ReturnType<typeof harness>["inbox"]) => inbox.accept(frame(2)),
      2,
      "sequence",
    ],
    [
      "a frame past the window",
      (inbox: ReturnType<typeof harness>["inbox"]) => {
        inbox.accept(frame(1));
        inbox.accept(frame(2));
        return inbox.accept(frame(3));
      },
      3,
      "window",
    ],
    [
      "a new frame after revocation",
      (inbox: ReturnType<typeof harness>["inbox"]) => {
        inbox.revoke();
        return inbox.accept(frame(1));
      },
      1,
      "revoked",
    ],
  ])("refuses %s and tells the guest why", (_name, act, seq, reason) => {
    const { inbox, replies } = harness(() => new Promise(() => undefined), {
      inflightFrames: 2,
      replyCache: 2,
    });

    expect(act(inbox)).toEqual({ ok: false, reason });
    expect(replies.at(-1)).toEqual({ re: seq, part: 0, body: { type: "refused", reason } });
  });

  it("refuses a resend whose reply left the cache", async () => {
    const { inbox, replies } = harness(async () => ({ type: "ack" }), {
      inflightFrames: 2,
      replyCache: 1,
    });

    inbox.accept(frame(1));
    inbox.accept(frame(2));
    await tick();

    expect(inbox.accept(frame(2))).toEqual({ ok: true });
    expect(inbox.accept(frame(1))).toEqual({ ok: false, reason: "sequence" });
    expect(replies.at(-1)).toEqual({
      re: 1,
      part: 0,
      body: { type: "refused", reason: "sequence" },
    });
  });
});
