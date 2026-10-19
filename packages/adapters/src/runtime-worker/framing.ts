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

const PREFIX_BYTES = 4;

export function encodeMessage(message: GuestMessageV1 | ControllerMessageV1): Uint8Array {
  return Buffer.from(JSON.stringify(message));
}

/** Prefix a frame with its big-endian 32-bit length, for a byte stream. */
export function encodeFrame(frame: Uint8Array): Uint8Array {
  const out = Buffer.allocUnsafe(PREFIX_BYTES + frame.byteLength);
  out.writeUInt32BE(frame.byteLength, 0);
  out.set(frame, PREFIX_BYTES);
  return out;
}

/** Split a byte stream into frames. An oversized frame throws on its prefix, before its body is read. */
export async function* readFrames(
  chunks: AsyncIterable<Uint8Array>,
  maxBytes: number,
): AsyncGenerator<Uint8Array> {
  let buffered = Buffer.alloc(0);
  for await (const chunk of chunks) {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
    while (buffered.length >= PREFIX_BYTES) {
      const length = buffered.readUInt32BE(0);
      if (length > maxBytes) throw new FrameTooLargeError(length);
      if (buffered.length < PREFIX_BYTES + length) break;
      yield buffered.subarray(PREFIX_BYTES, PREFIX_BYTES + length);
      buffered = buffered.subarray(PREFIX_BYTES + length);
    }
  }
}

/** A channel over a byte stream pair, such as a child's stdio. */
export function streamChannel(
  input: AsyncIterable<Uint8Array>,
  output: Writable,
  maxFrameBytes: number,
): FrameChannel {
  return {
    async send(frame) {
      if (output.writableEnded || output.destroyed) return;
      if (!output.write(encodeFrame(frame))) {
        await new Promise<void>((resolve) => {
          output.once("drain", resolve);
          output.once("close", resolve);
        });
      }
    },
    frames: readFrames(input, maxFrameBytes),
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

/** Size, then JSON, then schema. Only a model request may use the larger frame. */
export function readGuestFrame(frame: Uint8Array): FrameRead<GuestMessageV1> {
  if (frame.byteLength > WORKER_LIMITS.modelRequestBytes) return { ok: false, reason: "too_large" };
  const read = readJson(frame, parseGuestMessage);
  if (
    read.ok &&
    frame.byteLength > WORKER_LIMITS.guestFrameBytes &&
    !(read.message.kind === "worker.event" && read.message.payload.body.type === "model.request")
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
