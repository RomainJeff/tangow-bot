import type { SkillVersion } from "@rakazo/contracts";

/** A skill with one version the user wrote has no history worth showing. */
export function showsSkillVersions(versions: readonly SkillVersion[]): boolean {
  return versions.length > 1 || versions[0]?.author.kind === "bot";
}

/**
 * Undo goes back to the nearest older version that was not undone, as the server does. With none
 * left it removes the skill, which only a bot's fresh creation offers.
 */
export function canUndoSkillVersion(versions: readonly SkillVersion[]): boolean {
  const at = versions.findIndex((version) => version.current);
  if (at < 0) return false;
  if (versions.slice(at + 1).some((version) => !version.undone)) return true;
  const current = versions[at]!;
  return current.nature === "created" && current.author.kind === "bot";
}

export type SkillVersionWords = {
  learned: string;
  updated: string;
  you: string;
  unknown: string;
  undone: string;
};

/**
 * "Scout · learned", "You · updated", "Updated" for an author the history does not name, with
 * " · Undone" once the version was undone.
 */
export function skillVersionSubline(version: SkillVersion, words: SkillVersionWords): string {
  const { author } = version;
  const line =
    author.kind === "unknown"
      ? words.unknown
      : author.kind === "user"
        ? `${words.you} · ${words.updated}`
        : `${author.botName} · ${version.nature === "created" ? words.learned : words.updated}`;
  return version.undone ? `${line} · ${words.undone}` : line;
}
