/**
 * Per-bot skill visibility (Skills v2, phase 1).
 * `skillKey` is the identity shared by SkillSetting / BotSkill rows. For user skills it is
 * derived from the name with the same rule as the former case-insensitive unique index on
 * agent_skills (lower(name)), so a rename is the only thing that changes it.
 */
export type SkillAvailability = "all" | "selected";

export function userSkillKey(name: string): string {
  return `user:${name.trim().toLowerCase()}`;
}

export function asSkillAvailability(value: string | null | undefined): SkillAvailability {
  return value === "selected" ? "selected" : "all";
}

/** BotSkill.enabled (override) wins; otherwise availability decides. Missing = "all". */
export function isSkillVisible(input: {
  availability?: SkillAvailability | null;
  override?: boolean | null;
}): boolean {
  if (typeof input.override === "boolean") return input.override;
  return (input.availability ?? "all") === "all";
}
