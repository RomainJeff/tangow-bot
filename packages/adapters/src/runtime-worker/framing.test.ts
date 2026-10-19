import { describe, expect, it } from "vitest";
import { encodeFrame, FrameTooLargeError, readFrames, readGuestFrame } from "./framing.js";

async function collect(chunks: Uint8Array[], maxBytes: number) {
  async function* stream() {
    yield* chunks;
  }
  const frames: string[] = [];
  for await (const frame of readFrames(stream(), maxBytes))
    frames.push(Buffer.from(frame).toString());
  return frames;
}

const worker = { runId: "run_1", attemptId: "attempt_1", fence: 1 };
const event = (body: unknown) =>
  Buffer.from(
    JSON.stringify({ version: 1, kind: "worker.event", worker, payload: { seq: 1, body } }),
  );

describe("readFrames", () => {
  it("rebuilds frames split across chunks and several in one chunk", async () => {
    const stream = Buffer.concat(["a", "bb", "ccc"].map((text) => encodeFrame(Buffer.from(text))));
    const chunks = [stream.subarray(0, 2), stream.subarray(2, 9), stream.subarray(9)];

    expect(await collect(chunks, 16)).toEqual(["a", "bb", "ccc"]);
  });

  it("refuses an oversized frame on its length prefix, before any of its body arrives", async () => {
    const prefixOnly = encodeFrame(Buffer.alloc(2 * 1024 * 1024)).subarray(0, 4);

    await expect(collect([prefixOnly], 1024 * 1024)).rejects.toEqual(
      new FrameTooLargeError(2 * 1024 * 1024),
    );
  });
});

describe("readGuestFrame", () => {
  const big = "x".repeat(2 * 1024 * 1024);

  it("lets only a model request use the larger frame", () => {
    const request = readGuestFrame(
      event({
        type: "model.request",
        agent: "root",
        dialect: "pi-ai",
        call: { context: { messages: [{ role: "user", content: big }] }, options: {} },
      }),
    );
    const result = readGuestFrame(
      event({
        type: "tool.done",
        callId: "c1",
        output: { text: big, isError: false, truncated: false, totalBytes: big.length },
      }),
    );

    expect(request.ok).toBe(true);
    expect(result).toEqual({ ok: false, reason: "too_large" });
  });

  it.each([
    ["bytes that are not JSON", Buffer.from("{"), "invalid"],
    [
      "another protocol version",
      Buffer.from(JSON.stringify({ version: 2, kind: "worker.event", worker })),
      "version",
    ],
  ])("refuses %s", (_name, frame, reason) => {
    expect(readGuestFrame(frame)).toEqual({ ok: false, reason });
  });
});
