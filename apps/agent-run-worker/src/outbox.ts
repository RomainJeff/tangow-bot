import {
  type GuestBody,
  type ReplyBody,
  type ReplyFinal,
  type ReplyPart,
  ReplyPartSchema,
  type WorkerIdentity,
  type WorkerReplyV1,
} from "@rakazo/adapter-kit";
import { encodeMessage, WORKER_LIMITS } from "@rakazo/adapters/runtime-worker/wire";

const partTypes = new Set<string>(ReplyPartSchema.options.map((option) => option.shape.type.value));

function isFinal(body: ReplyBody): body is ReplyFinal {
  return !partTypes.has(body.type);
}

/**
 * The guest's half of the sequencing: every frame stays here, counted against the window, until
 * its final reply. A producer waits while the window is full, so the harness stalls instead of buffering.
 */
export interface Outbox {
  /** Queue an informative body. Resolves once it has room, not when acknowledged. */
  post(body: GuestBody): Promise<void>;
  /** Queue a request. Resolves with its final reply; parts reach `onPart` in order, once each. */
  request(body: GuestBody, onPart?: (part: ReplyPart) => void): Promise<ReplyFinal>;
  /** `request`, resolving first with the frame's sequence number once it is sent. */
  send(
    body: GuestBody,
    onPart?: (part: ReplyPart) => void,
  ): Promise<{ seq: number; final: Promise<ReplyFinal> }>;
  /** A new connection: every frame still waiting for its reply is resent, same sequence numbers. */
  attach(send: (frame: Uint8Array) => void): void;
  detach(): void;
  receive(reply: WorkerReplyV1["payload"]): void;
  /** Fail every waiting producer and request. */
  shutdown(error: Error): void;
}

type Entry = {
  frame: Uint8Array;
  nextPart: number;
  onPart?: (part: ReplyPart) => void;
  settle(final: ReplyFinal): void;
  fail(error: Error): void;
};

type Waiter = {
  body: GuestBody;
  frame?: Uint8Array;
  onPart?: (part: ReplyPart) => void;
  admitted(settled: { seq: number; final: Promise<ReplyFinal> }): void;
  fail(error: Error): void;
};

export function createOutbox(
  worker: WorkerIdentity,
  limits: { inflightFrames: number; inflightBytes: number } = WORKER_LIMITS,
): Outbox {
  const entries = new Map<number, Entry>();
  const waiters: Waiter[] = [];
  let nextSeq = 1;
  let bytes = 0;
  let send: ((frame: Uint8Array) => void) | undefined;
  let failure: Error | undefined;

  const admit = () => {
    while (waiters.length) {
      const waiter = waiters[0]!;
      waiter.frame ??= encodeMessage({
        version: 1,
        kind: "worker.event",
        worker,
        payload: { seq: nextSeq, body: waiter.body },
      });
      const size = waiter.frame.byteLength;
      const room =
        entries.size < limits.inflightFrames &&
        (entries.size === 0 || bytes + size <= limits.inflightBytes);
      if (!room) return;
      waiters.shift();
      const seq = nextSeq++;
      bytes += size;
      const frame = waiter.frame;
      const final = new Promise<ReplyFinal>((resolve, reject) => {
        entries.set(seq, {
          frame,
          nextPart: 0,
          onPart: waiter.onPart,
          settle(body) {
            entries.delete(seq);
            bytes -= size;
            resolve(body);
            admit();
          },
          fail: reject,
        });
      });
      waiter.admitted({ seq, final });
      send?.(frame);
    }
  };

  const enqueue = (body: GuestBody, onPart?: (part: ReplyPart) => void) =>
    new Promise<{ seq: number; final: Promise<ReplyFinal> }>((admitted, fail) => {
      if (failure) return fail(failure);
      waiters.push({ body, onPart, admitted, fail });
      admit();
    });

  return {
    async post(body) {
      const { final } = await enqueue(body);
      final.catch(() => undefined);
    },
    async request(body, onPart) {
      return await (await enqueue(body, onPart)).final;
    },
    send: enqueue,
    attach(next) {
      send = next;
      for (const entry of entries.values()) next(entry.frame);
    },
    detach() {
      send = undefined;
    },
    receive({ re, part, body }) {
      const entry = entries.get(re);
      if (!entry || part !== entry.nextPart) return;
      entry.nextPart += 1;
      if (isFinal(body)) entry.settle(body);
      else entry.onPart?.(body);
    },
    shutdown(error) {
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.fail(error);
      for (const entry of entries.values()) entry.fail(error);
      entries.clear();
    },
  };
}
