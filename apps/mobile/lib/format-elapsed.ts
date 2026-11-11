/**
 * Format wall-clock seconds since `startedAtMs` as `0.0s` / `1m 2.3s` — the
 * native `WorkingLine`'s ticking duration. Ported from
 * `packages/ui-web/src/format-elapsed.ts` rather than imported: mobile keeps
 * its own copy of small native-safe helpers instead of depending on the
 * web-only `@tangow/ui-web` package (its barrel renders `div`s).
 */
export function formatElapsed(startedAtMs: number, nowMs: number): string {
  const totalTenths = Math.round(Math.max(0, nowMs - startedAtMs) / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = (totalTenths % 600) / 10;
  if (minutes === 0) return `${seconds.toFixed(1)}s`;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

/**
 * Format a finished duration as `41s` / `2m 04s` — the reasoning summary reads
 * a total after the fact, so it drops the tenths a running clock needs. Ported
 * from `packages/ui-web/src/format-elapsed.ts` for the same reason as
 * `formatElapsed` above.
 */
export function formatShortDuration(durationMs: number): string {
  const totalSeconds = Math.round(Math.max(0, durationMs) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
