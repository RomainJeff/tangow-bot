import type { Parsed } from "../worker-channel-tap.js";

/** Match each guest request to its own duration and emulator TTFB before taking quantiles. */
export function directProxyOverheads(
  frames: Parsed[],
  served: Array<{ received: number; firstByte: number }>,
): number[] {
  const requests = frames.filter(
    (frame) => frame.from === "guest" && frame.type === "model.request",
  );
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
