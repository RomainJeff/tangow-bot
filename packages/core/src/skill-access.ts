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
 */
export function isSkillVisible(input: {
  availability?: SkillAvailability | null;
  override?: boolean | null;
}): boolean {
  const availability = input.availability ?? "all";
  if (availability === "disabled") return false;
  if (typeof input.override === "boolean") return input.override;
  return availability === "all";
}

/** Marketplace skills (phase 3): `mkt:<marketplace>/<plugin>/<slug>`, all three already lowercase. */
export function marketplaceSkillKey(marketplace: string, plugin: string, slug: string): string {
  return `mkt:${marketplace}/${plugin}/${slug}`;
}

export function isMarketplaceSkillKey(key: string): boolean {
  return key.startsWith("mkt:");
}

/** Marketplace skills start hidden (design Q8); user skills stay visible to every bot. */
export function defaultSkillAvailability(key: string): SkillAvailability {
  return isMarketplaceSkillKey(key) ? "selected" : "all";
}
