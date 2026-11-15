/** Settings that follow the person across spaces. */
export const ACCOUNT_SETTINGS_SECTIONS = ["profile", "providers", "updates"] as const;

/** Settings that belong to the active space. */
export const SPACE_SETTINGS_SECTIONS = [
  "space",
  "models",
  "voice",
  "memory",
  "decision-model",
  "computer",
  "vault",
  "usage",
] as const;

export type SettingsSection =
  | (typeof ACCOUNT_SETTINGS_SECTIONS)[number]
  | (typeof SPACE_SETTINGS_SECTIONS)[number];
