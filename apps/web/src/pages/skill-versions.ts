import { ORPCError } from "@orpc/client";
import type { SkillVersion } from "@rakazo/contracts";
import { threadTimeMarkerLabel } from "@rakazo/core";

/** The list as Undo leaves it, before the server's answer is read back. */
export function applyUndo(versions: SkillVersion[]): SkillVersion[] {
  const at = versions.findIndex((version) => version.current);
  const target = versions.findIndex((version, index) => index > at && !version.undone);
  if (at < 0 || target < 0) return versions;
  return versions.map((version, index) => {
    if (index === at) return { ...version, current: false, undone: true };
    if (index === target) return { ...version, current: true };
    return version;
  });
}

/** "Today 8:05 AM", "Yesterday 6:40 PM", then the weekday and date: the thread's time markers. */
export function formatVersionDate(
  iso: string,
  words: { locale: string; today: string; yesterday: string },
  now = new Date(),
): string {
  return threadTimeMarkerLabel(iso, { ...words, now });
}

const REFUSALS: ReadonlySet<string> = new Set(["CONFLICT", "BAD_REQUEST"]);

/**
 * The server's own sentence when it refused a change it understood, such as a write that landed
 * since the list was read or a name taken since. A fault of the server never reaches the screen.
 */
export function refusalMessage(error: unknown): string | null {
  return error instanceof ORPCError && REFUSALS.has(error.code) && error.message
    ? error.message
    : null;
}
