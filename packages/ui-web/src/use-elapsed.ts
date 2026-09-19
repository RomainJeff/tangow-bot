import { useEffect, useState } from "react";
import { formatElapsed } from "./format-elapsed.js";
import { usePrefersReducedMotion } from "./lib/reduced-motion.js";

/**
 * Wall-clock time since `startedAt` (epoch ms, defaulting to mount), ticking
 * every 100 ms. Under reduced motion it freezes on its first reading, so a run
 * never animates a number at someone who asked for stillness.
 */
export function useElapsed(startedAt?: number): string {
  const reducedMotion = usePrefersReducedMotion();
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (reducedMotion) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [reducedMotion]);
  return formatElapsed(startedAt ?? mountedAt, now);
}
