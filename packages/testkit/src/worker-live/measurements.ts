import type { Parsed } from "../worker-channel-tap.js";

/** Match each guest request to its own duration and emulator TTFB before taking quantiles. */
export function directProxyOverheads(
  frames: Parsed[],
  served: Array<{ received: number; firstByte: number }>,
): number[] {
  const seen = new Set<number | undefined>();
  const requests = frames.filter((frame) => {
    if (frame.from !== "guest" || frame.type !== "model.request" || seen.has(frame.seq))
      return false;
    seen.add(frame.seq);
    return true;
  });
  return requests.map((request, index) => {
    const latency = frames.find(
      (frame) => frame.from === "guest" && frame.modelLatency?.re === request.seq,
    )?.modelLatency;
    const upstream = served[index];
    if (!latency || !upstream)
      throw new Error("Missing direct model-call timing; rebuild the guest template");
    return latency.firstEventMs - (upstream.firstByte - upstream.received);
  });
}
