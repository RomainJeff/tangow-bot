import { describe, expect, it } from "vitest";
import { encodeFrameLine, FrameTooLargeError, readFrameLines, readGuestFrame } from "./framing.js";

async function collect(chunks: Array<Uint8Array | string>, maxBytes: number) {
  async function* stream() {
    yield* chunks;
  }
  const frames: Buffer[] = [];
  for await (const frame of readFrameLines(stream(), maxBytes)) frames.push(Buffer.from(frame));
  return frames;
}

/** What a reader sees of bytes that went through a streaming UTF-8 decoder, as E2B delivers them. */
function decodedAsText(bytes: Buffer, cuts: number[]) {
  const decoder = new TextDecoder();
  const edges = [0, ...cuts, bytes.length];
  return edges
    .slice(1)
    .map((end, index) => decoder.decode(bytes.subarray(edges[index], end), { stream: true }));
}

const worker = { runId: "run_1", attemptId: "attempt_1", fence: 1 };
const event = (body: unknown) =>
  Buffer.from(
    JSON.stringify({ version: 2, kind: "worker.event", worker, payload: { seq: 1, body } }),
  );

describe("readFrameLines", () => {
  it("rebuilds binary frames that crossed a text decoder in arbitrary chunks", async () => {
    const frames = [Buffer.from([0xff, 0x00, 0xc3]), Buffer.from("é ✓")];
    const stream = Buffer.from(frames.map(encodeFrameLine).join(""));

    expect(await collect(decodedAsText(stream, [1, 5, 6]), 16)).toEqual(frames);
  });

  it("skips blank lines between frames", async () => {
    const frame = Buffer.from("{}");

    expect(await collect(["\n", " \r\n", encodeFrameLine(frame), "\r\n"], 16)).toEqual([frame]);
  });

  it("refuses an oversized line before it ends", async () => {
    const line = encodeFrameLine(Buffer.alloc(2 * 1024 * 1024));
    const head = line.slice(0, Math.ceil((1024 * 1024) / 3) * 4 + 1);

    await expect(collect([head], 1024 * 1024)).rejects.toEqual(new FrameTooLargeError(1_048_578));
  });

  it("accepts a line of exactly the largest frame", async () => {
    const frame = Buffer.alloc(1024 * 1024, 7);

    expect(await collect([encodeFrameLine(frame)], 1024 * 1024)).toEqual([frame]);
  });
});

describe("readGuestFrame", () => {
  const big = "x".repeat(2 * 1024 * 1024);

  it("keeps ordinary frames bounded while allowing complete model requests", () => {
    const request = readGuestFrame(
      event({
        type: "model.request",
        agent: "root",
        dialect: "pi-ai",
        call: { context: { messages: [{ role: "user", content: big }] }, options: {} },
      }),
    );
    const result = readGuestFrame(event({ type: "text", text: big }));

    expect(request.ok).toBe(true);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it.each([
    ["bytes that are not JSON", Buffer.from("{"), "invalid"],
    [
      "another protocol version",
      Buffer.from(JSON.stringify({ version: 1, kind: "worker.event", worker })),
      "version",
    ],
  ])("refuses %s", (_name, frame, reason) => {
    expect(readGuestFrame(frame)).toEqual({ ok: false, reason });
  });
});

it("transfers a complete native snapshot above the ordinary frame limit without truncation", () => {
  const state = "x".repeat(2 * 1024 * 1024);
  const body = {
    type: "snapshot.save",
    snapshot: {
      version: 1,
      harness: { name: "other-harness", format: "fixture" },
      deliveredEvents: [],
      pendingCallIds: [],
      revision: 1,
      state,
    },
  };
  expect(readGuestFrame(event(body))).toEqual({
    ok: true,
    message: { version: 2, kind: "worker.event", worker, payload: { seq: 1, body } },
  });
});
