import type {
  AgentRuntimeEvent,
  ControllerMessageV1,
  GuestBody,
  HarnessDeclaration,
  ReplyBody,
  WorkerIdentity,
} from "@rakazo/adapter-kit";
import type { FrameChannel, LaunchedGuest } from "./index.js";
import {
  capabilityWorker,
  encodeMessage,
  memoryChannelPair,
  readControllerFrame,
} from "./index.js";

/** A guest that speaks the wire by hand, so it can do what a conforming guest never would. */
export function rawGuest(
  channel: FrameChannel,
  capability: string,
  harness: HarnessDeclaration = { name: "pi", capabilities: ["subagents", "steering"] },
) {
  const worker = capabilityWorker(capability)!;
  const received: ControllerMessageV1[] = [];
  const replies = new Map<number, ReplyBody[]>();
  let notify = () => {};
  const closed = (async () => {
    for await (const frame of channel.frames) {
      const read = readControllerFrame(frame);
      if (!read.ok) continue;
      received.push(read.message);
      if (read.message.kind === "worker.reply") {
        const { re, body } = read.message.payload;
        replies.set(re, [...(replies.get(re) ?? []), body]);
      }
      notify();
    }
  })();
  const until = async <T>(check: () => T | undefined): Promise<T> => {
    while (true) {
      const found = check();
      if (found !== undefined) return found;
      await new Promise<void>((resume) => (notify = resume));
    }
  };
  return {
    received,
    closed,
    hello() {
      void channel.send(
        encodeMessage({
          version: 1,
          kind: "worker.hello",
          worker,
          capability,
          harness,
        }),
      );
      return until(() => received.find((message) => message.kind === "worker.start"));
    },
    send(seq: number, body: GuestBody) {
      void channel.send(
        encodeMessage({ version: 1, kind: "worker.event", worker, payload: { seq, body } }),
      );
    },
    /** Every reply body to `seq`, once one settles it or `count` arrived. */
    replies(seq: number, count = Infinity) {
      return until(() => {
        const bodies = replies.get(seq) ?? [];
        const settled = bodies.some(
          (body) => body.type !== "model.event" && body.type !== "end.refused",
        );
        return settled || bodies.length >= count ? bodies : undefined;
      });
    },
  };
}

/** Hands every launch to the test: it opens the guest's connections itself. */
export function manualLauncher() {
  /** `held`: the attempt may act; `owned`: the run is still its own, possibly waiting on the user. */
  const fence = { held: true, owned: true };
  const launched = new Map<string, { capability: string; connect(): FrameChannel }>();
  const waiting = new Map<string, () => void>();
  return {
    fence,
    launcher: {
      async launch(worker: WorkerIdentity, capability: string): Promise<LaunchedGuest> {
        const queue: FrameChannel[] = [];
        let wake = () => {};
        launched.set(worker.runId, {
          capability,
          connect() {
            const pair = memoryChannelPair();
            queue.push(pair.controller);
            wake();
            return pair.guest;
          },
        });
        waiting.get(worker.runId)?.();
        return {
          start: {
            version: 1,
            kind: "worker.start",
            worker,
            workspace: { cwd: "/workspace", mounts: [] },
            computer: "none",
          },
          connections: (async function* () {
            while (true) {
              const next = queue.shift();
              if (next) yield next;
              else await new Promise<void>((resume) => (wake = resume));
            }
          })(),
          exited: Promise.resolve(),
          release: async () => "released",
          holdsFence: async () => fence.held,
          ownsFence: async () => fence.owned,
        };
      },
    },
    async launchedFor(runId: string) {
      if (!launched.has(runId)) await new Promise<void>((resume) => waiting.set(runId, resume));
      return launched.get(runId)!;
    },
  };
}

export const stillClock = { sleep: () => new Promise<void>(() => {}) };

export function consume(events: AsyncIterable<AgentRuntimeEvent>) {
  const seen: AgentRuntimeEvent[] = [];
  const done = (async () => {
    for await (const event of events) seen.push(event);
  })();
  done.catch(() => undefined);
  return { seen, done };
}
