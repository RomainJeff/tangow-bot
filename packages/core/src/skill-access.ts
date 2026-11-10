/**
 * Per-bot skill visibility (Skills v2, phase 1).
 * `skillKey` is the identity shared by SkillSetting / BotSkill rows. For user skills it is
 * derived from the name with the same rule as the former case-insensitive unique index on
 * agent_skills (lower(name)), so a rename is the only thing that changes it.
 */
export type SkillAvailability = "disabled" | "all" | "selected";

export function userSkillKey(name: string): string {
  return `user:${name.trim().toLowerCase()}`;
}

export function asSkillAvailability(value: string | null | undefined): SkillAvailability {
  if (value === "disabled" || value === "selected") return value;
  return "all";
}

/**
 * "disabled" hides the skill from every bot, overrides included; otherwise
 * BotSkill.enabled (override) wins and availability decides. Missing = "all".
 * A shared bot sees only the skills its owner turned on for it.
 */
export function isSkillVisible(input: {
  availability?: SkillAvailability | null;
  override?: boolean | null;
  sharedBot?: boolean;
}): boolean {
  const availability = input.availability ?? "all";
  if (availability === "disabled") return false;
  if (typeof input.override === "boolean") return input.override;
  return availability === "all" && !input.sharedBot;
}

/** Skill versions an earlier build kept under the data dir; account deletion still removes them. */
export const SKILL_HISTORY_DIR = "skill-history";

/** Where the computer mounts skill files read-only; the supervisor binds and skill_read agree. */
export const SANDBOX_SKILL_MOUNTS = {
  user: "/skills/user",
  managed: "/managed-skills",
} as const;

export type SkillListEntry = {
  name: string;
  description: string;
  availability: SkillAvailability;
  visibleBotIds: string[];
};

/**
 * Skills panel list filter, shared by web and mobile.
 * `filter` is "all" | "active" | "disabled" | `bot:<id>`; `botId` puts the list in
 * bot mode, where globally disabled skills are not offered at all.
 */
export function filterSkillList<T extends SkillListEntry>(
  entries: readonly T[],
  options: { query?: string; filter?: string; botId?: string } = {},
): T[] {
  const { query = "", filter = "all", botId } = options;
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (botId && entry.availability === "disabled") return false;
    if (needle && !`${entry.name} ${entry.description}`.toLowerCase().includes(needle))
      return false;
    if (filter === "active") return entry.availability !== "disabled";
    if (filter === "disabled") return entry.availability === "disabled";
    if (filter.startsWith("bot:")) return entry.visibleBotIds.includes(filter.slice(4));
    return true;
  });
}
