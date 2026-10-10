/**
 * Whether bots keep and improve their methods as skills on their own. "off" keeps today's
 * wording; "shadow" switches the wording and only records when the end-of-exchange nudge would
 * have run; "on" runs it. It stays off until every client shows the skill line.
 */
export type SkillLearningMode = "off" | "shadow" | "on";

const MODES: readonly SkillLearningMode[] = ["off", "shadow", "on"];

/** The deployment setting (`SKILL_LEARNING`): anything but "shadow" or "on" is off. */
export function parseSkillLearningMode(raw: string | undefined): SkillLearningMode {
  const value = raw?.trim().toLowerCase();
  return MODES.find((mode) => mode === value) ?? "off";
}
