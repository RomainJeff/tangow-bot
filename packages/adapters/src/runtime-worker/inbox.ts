import type {
  GuestBody,
  RefusalReason,
  ReplyBody,
  ReplyFinal,
  ReplyPart,
  WorkerEventV1,
  WorkerIdentity,
  WorkerReplyV1,
} from "@rakazo/adapter-kit";
import { WORKER_LIMITS } from "./limits.js";

/**
 * Decides one guest frame. Stream parts with `part`; the returned body settles the frame. A
 * rejection settles it as `error`. Called once per sequence number, however often it is resent.
 */
export type InboxHandler = (
  seq: number,
  body: GuestBody,
  part: (body: ReplyPart) => void,
) => Promise<ReplyFinal>;

export type InboxOutcome = { ok: true } | { ok: false; reason: RefusalReason };

/**
 * The controller's half of the sequencing. Lives as long as the attempt's session: a controller
 * restart ends the attempt, so dedup by `(attempt, seq)` in memory is enough.
 */
export interface SessionInbox {
  /** Send replies to this connection from now on. */
  attach(send: (reply: WorkerReplyV1) => void): void;
  detach(): void;
  /** On refusal the guest got a `refused` reply; close the channel. */
  accept(event: WorkerEventV1): InboxOutcome;
  /** Every new frame is refused as revoked from now on. */
  revoke(): void;
}

type Entry = { parts: ReplyBody[]; settled: boolean };

function sameWorker(a: WorkerIdentity, b: WorkerIdentity) {
  return a.runId === b.runId && a.attemptId === b.attemptId && a.fence === b.fence;
}

export function createSessionInbox(
  worker: WorkerIdentity,
  handle: InboxHandler,
  limits: { inflightFrames: number; replyCache: number } = WORKER_LIMITS,
): SessionInbox {
  let send: ((reply: WorkerReplyV1) => void) | undefined;
  let received = 0;
  let open = 0;
  let revoked = false;
  const entries = new Map<number, Entry>();
  const settledOrder: number[] = [];

  const emit = (re: number, part: number, body: ReplyBody) =>
    send?.({ version: 1, kind: "worker.reply", worker, payload: { re, part, body } });

  const reply = (re: number, entry: Entry, body: ReplyBody) => {
    entry.parts.push(body);
    emit(re, entry.parts.length - 1, body);
  };

  const refuse = (seq: number, reason: RefusalReason): InboxOutcome => {
    emit(seq, 0, { type: "refused", reason });
    return { ok: false, reason };
  };

  const settle = (seq: number, entry: Entry, body: ReplyFinal) => {
    reply(seq, entry, body);
    entry.settled = true;
    open -= 1;
    settledOrder.push(seq);
    while (settledOrder.length > limits.replyCache) entries.delete(settledOrder.shift()!);
  };

  return {
    attach(next) {
      send = next;
    },
    detach() {
      send = undefined;
    },
    accept(event) {
      const { seq, body } = event.payload;
      if (!sameWorker(event.worker, worker)) return refuse(seq, "identity");
      if (seq <= received) {
        const entry = entries.get(seq);
        if (!entry) return refuse(seq, "sequence");
        for (const [part, body] of entry.parts.entries()) emit(seq, part, body);
        return { ok: true };
      }
      if (seq !== received + 1) return refuse(seq, "sequence");
      if (revoked) return refuse(seq, "revoked");
      if (open >= limits.inflightFrames) return refuse(seq, "window");
      received = seq;
      open += 1;
      const entry: Entry = { parts: [], settled: false };
      entries.set(seq, entry);
      Promise.resolve()
        .then(() =>
          handle(seq, body, (part) => {
            if (!entry.settled) reply(seq, entry, part);
          }),
        )
        .then(
          (final) => settle(seq, entry, final),
          (error: unknown) =>
            settle(seq, entry, {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            }),
        );
      return { ok: true };
    },
    revoke() {
      revoked = true;
    },
  };
}
