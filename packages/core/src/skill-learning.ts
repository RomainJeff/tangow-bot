/**
 * Whether bots keep and improve their methods as skills on their own. "off" keeps the bot's
 * `/Name` announcement; "shadow" and "on" switch the wording.
 */
export type SkillLearningMode = "off" | "shadow" | "on";

const MODES: readonly SkillLearningMode[] = ["off", "shadow", "on"];

export const DEFAULT_SKILL_LEARNING: SkillLearningMode = "shadow";

/**
 * The deployment setting (`SKILL_LEARNING`): unset or empty is the default; a value that is not
 * a mode is off, so a typo never stops the announcement on clients without the skill line.
 */
export function parseSkillLearningMode(raw: string | undefined): SkillLearningMode {
  const value = raw?.trim().toLowerCase();
  if (!value) return DEFAULT_SKILL_LEARNING;
  return MODES.find((mode) => mode === value) ?? "off";
}
