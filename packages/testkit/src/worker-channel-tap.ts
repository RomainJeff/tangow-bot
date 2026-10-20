import { performance } from "node:perf_hooks";
import type { FrameChannel, GuestConnector } from "@rakazo/adapters/runtime-worker";
import type { PrismaClient } from "@rakazo/db";

/** A frame as the controller's side of the channel read or sent it. */
export type Seen = { at: number; from: "guest" | "controller"; frame: Uint8Array };
type Query = { at: number; ms: number };

export function quantiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const round = (value: number | undefined) =>
    value === undefined ? null : Math.round(value * 1000) / 1000;
  return {
    count: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
}

/** Every query the controller sends, with when it started and how long it took. */
export function queryLog() {
  const queries: Query[] = [];
  return {
    queries,
    wrap: (prisma: PrismaClient) =>
      prisma.$extends({
        query: {
          async $allOperations({ args, query }) {
            const at = performance.now();
            try {
              return await query(args);
            } finally {
              queries.push({ at, ms: performance.now() - at });
            }
          },
        },
      }) as unknown as PrismaClient,
    within(from: number, to: number) {
      const inside = queries.filter((query) => query.at >= from && query.at <= to);
      return { count: inside.length, ms: inside.reduce((sum, query) => sum + query.ms, 0) };
    },
  };
}

/** Records every frame at the controller's side of the channel, as the session reads or sends it. */
export function tapConnector(
  connector: GuestConnector,
  seen: Seen[],
  connects: number[],
): GuestConnector {
  const tap = (channel: FrameChannel): FrameChannel => ({
    frames: (async function* () {
      for await (const frame of channel.frames) {
        seen.push({ at: performance.now(), from: "guest", frame });
        yield frame;
      }
    })(),
    send(frame) {
      seen.push({ at: performance.now(), from: "controller", frame });
      return channel.send(frame);
    },
    close: () => channel.close(),
  });
  return {
    connect(target, capability) {
      connects.push(performance.now());
      const guest = connector.connect(target, capability);
      return {
        exited: guest.exited,
        connections: (async function* () {
          for await (const channel of guest.connections) yield tap(channel);
        })(),
      };
    },
  };
}

export type Parsed = {
  at: number;
  from: Seen["from"];
  kind: string;
  seq?: number;
  re?: number;
  type?: string;
  modelLatency?: { re: number; firstEventMs: number };
};

export function parse(seen: Seen[]): Parsed[] {
  return seen.map(({ at, from, frame }) => {
    const message = JSON.parse(Buffer.from(frame).toString()) as {
      kind: string;
      payload?: {
        seq?: number;
        re?: number;
        body?: { type?: string; re?: number; firstEventMs?: number };
      };
    };
    return {
      at,
      from,
      kind: message.kind,
      seq: message.payload?.seq,
      re: message.payload?.re,
      type: message.payload?.body?.type,
      ...(message.payload?.body?.type === "model.latency" &&
      typeof message.payload.body.re === "number" &&
      typeof message.payload.body.firstEventMs === "number"
        ? {
            modelLatency: {
              re: message.payload.body.re,
              firstEventMs: message.payload.body.firstEventMs,
            },
          }
        : {}),
    };
  });
}

/** The controller-side time from each guest request to its reply of the given type. */
export function settled(frames: Parsed[], request: string, reply: string) {
  return frames.flatMap((frame) => {
    if (frame.from !== "guest" || frame.type !== request) return [];
    const answer = frames.find(
      (candidate) =>
        candidate.from === "controller" && candidate.re === frame.seq && candidate.type === reply,
    );
    return answer ? [{ from: frame.at, to: answer.at }] : [];
  });
}
