import type { Writable } from "node:stream";
import {
  type ControllerMessageV1,
  type GuestMessageV1,
  parseControllerMessage,
  parseGuestMessage,
  type RefusalReason,
  type WireParse,
} from "@rakazo/adapter-kit";
import { WORKER_LIMITS } from "./limits.js";

/** One connection: ordered whole frames, no retransmission of its own. A reconnect is a new channel. */
export interface FrameChannel {
  /** Never rejects. A frame sent once the connection is lost is dropped, as on a cut socket. */
  send(frame: Uint8Array): Promise<void>;
  /** Ends when the connection does. */
  frames: AsyncIterable<Uint8Array>;
  close(): void;
}

export class FrameTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Frame of ${bytes} bytes exceeds the limit`);
    this.name = "FrameTooLargeError";
  }
}

export function encodeMessage(message: GuestMessageV1 | ControllerMessageV1): Uint8Array {
  return Buffer.from(JSON.stringify(message));
}

/**
 * One base64 line per frame. A guest's stdio may reach the controller through a text decoder, as
 * E2B delivers command output, and base64 survives it where raw bytes would not.
 */
export function encodeFrameLine(frame: Uint8Array): string {
  return `${Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString("base64")}\n`;
}

/** Split a stream of frame lines into frames. A blank line is no frame. An oversized line throws before it ends. */
export async function* readFrameLines(
  chunks: AsyncIterable<Uint8Array | string>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  const maxLine = Math.ceil(maxBytes / 3) * 4;
  let parts: string[] = [];
  let length = 0;
  const grow = (by: number) => {
    length += by;
    if (length > maxLine) throw new FrameTooLargeError(Math.floor((length * 3) / 4));
  };
  for await (const chunk of chunks) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1");
    let start = 0;
    for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
      grow(end - start);
      parts.push(text.slice(start, end));
      const line = parts.join("").trim();
      if (line) yield Buffer.from(line, "base64");
      parts = [];
      length = 0;
      start = end + 1;
    }
    grow(text.length - start);
    if (start < text.length) parts.push(text.slice(start));
  }
}

/** A channel over a stream pair, such as a child's stdio, in frame lines. */
export function streamChannel(
  input: AsyncIterable<Uint8Array>,
  output: Writable,
  maxFrameBytes: number,
): FrameChannel {
  return {
    async send(frame) {
      if (output.writableEnded || output.destroyed) return;
      if (!output.write(encodeFrameLine(frame))) {
        await new Promise<void>((resolve) => {
          output.once("drain", resolve);
          output.once("close", resolve);
        });
      }
    },
    frames: readFrameLines(input, maxFrameBytes),
    close() {
      output.end();
    },
  };
}

type FrameRead<T> = { ok: true; message: T } | { ok: false; reason: RefusalReason };

function readJson<T>(frame: Uint8Array, parse: (json: unknown) => WireParse<T>): FrameRead<T> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).toString());
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const parsed = parse(json);
  if (parsed.ok) return parsed;
  return { ok: false, reason: parsed.reason === "unsupported_version" ? "version" : "invalid" };
}

/** Size, then JSON, then schema. Model requests, transcripts and complete snapshots use the larger frame. */
export function readGuestFrame(frame: Uint8Array): FrameRead<GuestMessageV1> {
  if (frame.byteLength > WORKER_LIMITS.modelRequestBytes) return { ok: false, reason: "too_large" };
  const read = readJson(frame, parseGuestMessage);
  if (
    read.ok &&
    frame.byteLength > WORKER_LIMITS.guestFrameBytes &&
    !(
      read.message.kind === "worker.event" &&
      (read.message.payload.body.type === "model.request" ||
        read.message.payload.body.type === "transcript" ||
        read.message.payload.body.type === "snapshot.save")
    )
  ) {
    return { ok: false, reason: "too_large" };
  }
  return read;
}

export function readControllerFrame(frame: Uint8Array): FrameRead<ControllerMessageV1> {
  if (frame.byteLength > WORKER_LIMITS.controllerFrameBytes) {
    return { ok: false, reason: "too_large" };
  }
  return readJson(frame, parseControllerMessage);
}
