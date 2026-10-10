import { ORPCError } from "@orpc/client";
import type { SkillVersion } from "@rakazo/contracts";
import { threadTimeMarkerLabel } from "@rakazo/core";

/** A skill with one version written by the user has no history worth showing. */
export function showVersions(versions: SkillVersion[], readOnly: boolean): boolean {
  if (readOnly) return false;
  if (versions.length > 1) return true;
  return versions[0]?.author.kind === "bot";
}

/**
 * Undo goes back to the nearest older version that was not undone. With none left it removes
 * the skill, which only a bot's fresh creation offers.
 */
export function canUndo(versions: SkillVersion[]): boolean {
  const at = versions.findIndex((version) => version.current);
  if (at < 0) return false;
  if (versions.slice(at + 1).some((version) => !version.undone)) return true;
  const current = versions[at]!;
  return current.nature === "created" && current.author.kind === "bot";
}

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

export type VersionWords = { learned: string; updated: string; you: string; unknown: string };

export function versionSubline(version: SkillVersion, words: VersionWords): string {
  const { author } = version;
  if (author.kind === "unknown") return words.unknown;
  if (author.kind === "user") return `${words.you} · ${words.updated}`;
  return `${author.botName} · ${version.nature === "created" ? words.learned : words.updated}`;
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
