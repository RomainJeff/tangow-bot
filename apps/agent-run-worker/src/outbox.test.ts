import type { GuestBody, ReplyPart } from "@tangow/adapter-kit";
import {
  createSessionInbox,
  encodeMessage,
  type FrameChannel,
  memoryChannelPair,
  readControllerFrame,
  readGuestFrame,
} from "@tangow/adapters/runtime-worker";
import { describe, expect, it } from "vitest";
import { createOutbox, type Outbox } from "./outbox.js";

const worker = { runId: "run_1", attemptId: "attempt_1", fence: 1 };
const text = (value: string): GuestBody => ({ type: "text", text: value });
const delta = (value: string): ReplyPart => ({
  type: "model.event",
  event: { type: "text_delta", contentIndex: 0, delta: value },
});

function wire(outbox: Outbox) {
  const sent: Array<{ seq: number; body: GuestBody }> = [];
  outbox.attach((frame) => {
    const read = readGuestFrame(frame);
    if (read.ok && read.message.kind === "worker.event") sent.push(read.message.payload);
  });
  return sent;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createOutbox", () => {
  it("holds a producer while the window is full and sends it once a reply frees a slot", async () => {
    const outbox = createOutbox(worker, { inflightFrames: 2, inflightBytes: 1 << 20 });
    const sent = wire(outbox);
    await outbox.post(text("a"));
    await outbox.post(text("b"));
    let thirdQueued = false;
    const third = outbox.post(text("c")).then(() => (thirdQueued = true));
    await tick();
    const beforeAck = sent.map((frame) => frame.seq);

    outbox.receive({ re: 1, part: 0, body: { type: "ack" } });
    await third;

    expect(beforeAck).toEqual([1, 2]);
    expect(thirdQueued).toBe(true);
    expect(sent).toEqual([
      { seq: 1, body: text("a") },
      { seq: 2, body: text("b") },
      { seq: 3, body: text("c") },
    ]);
  });

  it("lets a lone frame larger than the byte budget through, and holds the next", async () => {
    const outbox = createOutbox(worker, { inflightFrames: 8, inflightBytes: 10 });
    const sent = wire(outbox);
    await outbox.post(text("larger than ten bytes"));
    outbox.post(text("next"));
    await tick();

    expect(sent.map((frame) => frame.seq)).toEqual([1]);
  });

  it("resends after a reconnect only the frames still waiting for their reply", async () => {
    const outbox = createOutbox(worker);
    wire(outbox);
    await outbox.post(text("acknowledged"));
    const pending = outbox.request({ type: "steering.claim", seenIds: [] });
    outbox.receive({ re: 1, part: 0, body: { type: "ack" } });
    outbox.detach();

    const resent = wire(outbox);
    outbox.receive({ re: 2, part: 0, body: { type: "steering", messages: [] } });

    expect(resent).toEqual([{ seq: 2, body: { type: "steering.claim", seenIds: [] } }]);
    expect(await pending).toEqual({ type: "steering", messages: [] });
  });

  it("hands each streamed part over once when the controller replays them", async () => {
    const outbox = createOutbox(worker);
    wire(outbox);
    const parts: ReplyPart[] = [];
    const reply = outbox.request(
      {
        type: "model.request",
        agent: "root",
        dialect: "pi-ai",
        call: { context: { messages: [] }, options: {} },
      },
      (part) => parts.push(part),
    );
    await tick();
    outbox.receive({ re: 1, part: 0, body: delta("a") });
    outbox.receive({ re: 1, part: 1, body: delta("b") });
    outbox.receive({ re: 1, part: 0, body: delta("a") });
    outbox.receive({ re: 1, part: 1, body: delta("b") });
    outbox.receive({ re: 1, part: 2, body: { type: "model.end" } });

    expect(await reply).toEqual({ type: "model.end" });
    expect(parts).toEqual([delta("a"), delta("b")]);
  });

  it("fails waiting producers and open requests on shutdown", async () => {
    const outbox = createOutbox(worker, { inflightFrames: 1, inflightBytes: 1 << 20 });
    wire(outbox);
    const open = outbox.request({ type: "steering.claim", seenIds: [] });
    const waiting = outbox.post(text("waiting"));
    await tick();
    outbox.shutdown(new Error("cancelled"));

    await expect(open).rejects.toThrow("cancelled");
    await expect(waiting).rejects.toThrow("cancelled");
  });
});

describe("outbox and session inbox over a cut connection", () => {
  function connect(
    outbox: Outbox,
    inbox: ReturnType<typeof createSessionInbox>,
    pair: {
      controller: FrameChannel;
      guest: FrameChannel;
    },
  ) {
    inbox.attach((reply) => void pair.controller.send(encodeMessage(reply)));
    void (async () => {
      for await (const frame of pair.controller.frames) {
        const read = readGuestFrame(frame);
        if (read.ok && read.message.kind === "worker.event") inbox.accept(read.message);
      }
    })();
    outbox.attach((frame) => void pair.guest.send(frame));
    void (async () => {
      for await (const frame of pair.guest.frames) {
        const read = readControllerFrame(frame);
        if (read.ok && read.message.kind === "worker.reply") outbox.receive(read.message.payload);
      }
    })();
  }

  it("answers a tool call whose reply was lost from the reply cache, running it once", async () => {
    let runs = 0;
    const inbox = createSessionInbox(worker, async () => {
      runs += 1;
      return { type: "tool.result", output: { sent: true } };
    });
    const outbox = createOutbox(worker);
    let replyLost: () => void = () => undefined;
    const lost = new Promise<void>((resolve) => (replyLost = resolve));
    const first = memoryChannelPair({
      dropControllerFrame: (frame) => {
        if (frame.type === "tool.result") replyLost();
        return frame.type === "tool.result";
      },
    });
    connect(outbox, inbox, first);

    const result = outbox.request({
      type: "tool.call",
      agent: "root",
      callId: "call_1",
      name: "send_email",
      args: { to: "a@example.test" },
    });
    await lost;
    first.guest.close();
    outbox.detach();
    connect(outbox, inbox, memoryChannelPair());

    expect(await result).toEqual({ type: "tool.result", output: { sent: true } });
    expect(runs).toBe(1);
  });
});
