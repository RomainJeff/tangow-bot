import type { FrameChannel } from "./framing.js";

/** What a fault sees of a frame. */
export interface FrameSummary {
  kind: string;
  /** The body type of an event or a reply. */
  type?: string;
  seq?: number;
  re?: number;
}

/** Test faults applied inside an in-memory connection. Consulted for every frame. */
export interface ChannelFaults {
  /** Lose this controller frame. */
  dropControllerFrame?(frame: FrameSummary): boolean;
  /** Sever the connection right after delivering this guest frame. */
  cutAfterGuestFrame?(frame: FrameSummary): boolean;
  /** Deliver this guest frame, and every later one, once the promise settles. */
  holdGuestFrame?(frame: FrameSummary): Promise<void> | undefined;
}

function summarize(frame: Uint8Array): FrameSummary {
  const message = JSON.parse(Buffer.from(frame).toString()) as {
    kind: string;
    payload?: { seq?: number; re?: number; body?: { type?: string } };
  };
  return {
    kind: message.kind,
    type: message.payload?.body?.type,
    seq: message.payload?.seq,
    re: message.payload?.re,
  };
}

function frameQueue() {
  const queued: Uint8Array[] = [];
  let waiting: ((result: IteratorResult<Uint8Array>) => void) | undefined;
  let closed = false;
  return {
    push(frame: Uint8Array) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ value: frame, done: false });
      } else queued.push(frame);
    },
    close() {
      closed = true;
      waiting?.({ value: undefined, done: true });
      waiting = undefined;
    },
    async *frames(): AsyncGenerator<Uint8Array> {
      while (true) {
        const next = queued.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        const result = await new Promise<IteratorResult<Uint8Array>>((resolve) => {
          waiting = resolve;
        });
        if (result.done) return;
        yield result.value;
      }
    },
  };
}

/** One in-process connection. Frames sent after it closes are lost, as on a cut socket. */
export function memoryChannelPair(faults: ChannelFaults = {}): {
  controller: FrameChannel;
  guest: FrameChannel;
} {
  const toController = frameQueue();
  const toGuest = frameQueue();
  let open = true;
  const cut = () => {
    open = false;
    toController.close();
    toGuest.close();
  };
  let guestSends = Promise.resolve();
  return {
    controller: {
      async send(frame) {
        if (open && !faults.dropControllerFrame?.(summarize(frame))) toGuest.push(frame);
      },
      frames: toController.frames(),
      close: cut,
    },
    guest: {
      send(frame) {
        guestSends = guestSends.then(async () => {
          const summary = summarize(frame);
          await faults.holdGuestFrame?.(summary);
          if (!open) return;
          toController.push(frame);
          if (faults.cutAfterGuestFrame?.(summary)) cut();
        });
        return guestSends;
      },
      frames: toGuest.frames(),
      close: cut,
    },
  };
}
