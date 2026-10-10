import type { SkillVersion } from "@rakazo/contracts";
import { serverMessage } from "./server-error";

/** A skill with one version the user wrote has no history worth showing; its Delete stays. */
export function showsVersions(versions: readonly SkillVersion[]): boolean {
  return versions.length > 1 || versions[0]?.author.kind === "bot";
}

/**
 * Undo goes back one kept version, or trashes a bot's fresh creation. A version left alone
 * after the earlier ones were purged or undone is not offered, as the server refuses it.
 */
export function canUndo(versions: readonly SkillVersion[]): boolean {
  const kept = versions.filter((version) => !version.undone);
  const [current, previous] = kept;
  if (!current?.current) return false;
  return previous !== undefined || (current.author.kind === "bot" && current.nature === "created");
}

export function currentVersion(versions: readonly SkillVersion[]): SkillVersion | undefined {
  return versions.find((version) => version.current);
}

type Words = { learned: string; updated: string; you: string; undone: string; unknown: string };

/**
 * "Claudius · learned", "You · updated", "Updated" for an author the history does not name,
 * with " · Undone" once the version was undone.
 */
export function versionSubline(version: SkillVersion, words: Words): string {
  const nature = version.nature === "created" ? words.learned : words.updated;
  const line =
    version.author.kind === "bot"
      ? `${version.author.botName} · ${nature}`
      : version.author.kind === "user"
        ? `${words.you} · ${words.updated}`
        : words.unknown;
  return version.undone ? `${line} · ${words.undone}` : line;
}

export type UndoOutcome =
  | { kind: "restored"; skillId: string }
  | { kind: "trashed" }
  | { kind: "refused"; message: string };

type UndoResult = { kind: "restored"; skillId: string; name: string } | { kind: "trashed" };

/** What the screen does after an Undo: show the new state, leave, or say why it was refused. */
export async function undoOutcome(undo: () => Promise<UndoResult>): Promise<UndoOutcome> {
  try {
    const result = await undo();
    return result.kind === "trashed" ? result : { kind: "restored", skillId: result.skillId };
  } catch (error) {
    return { kind: "refused", message: serverMessage(error) };
  }
}

/** The id the skill a thread line names has now, which a rename since the line changed. */
export function skillIdForUid<T extends { id: string }>(
  entries: readonly T[],
  uid: string,
  uidOf: (entry: T) => string | undefined,
): string | null {
  return entries.find((entry) => uidOf(entry) === uid)?.id ?? null;
}

export type RestoredSkill = { skillId: string; botGone: boolean };

let restored: RestoredSkill | null = null;

/** Hands the skill just brought back from the trash to the Skills group that shows it again. */
export function markRestored(skill: RestoredSkill): void {
  restored = skill;
}

export function takeRestored(): RestoredSkill | null {
  const skill = restored;
  restored = null;
  return skill;
}
