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
  "usage",
] as const;

export type SettingsSection =
  | (typeof ACCOUNT_SETTINGS_SECTIONS)[number]
  | (typeof SPACE_SETTINGS_SECTIONS)[number];

const SETTINGS_SECTIONS: readonly string[] = [
  ...ACCOUNT_SETTINGS_SECTIONS,
  ...SPACE_SETTINGS_SECTIONS,
];

function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && SETTINGS_SECTIONS.includes(value);
}

// Switching space reloads the app; this reopens settings where the person left it.
const REOPEN_SETTINGS_KEY = "rakazo:reopen-settings";

export function reopenSettingsAfterReload(section: SettingsSection) {
  try {
    window.sessionStorage.setItem(REOPEN_SETTINGS_KEY, section);
  } catch {
    // Without storage the switch still works; settings just stay closed.
  }
}

export function takeSettingsSectionToReopen(): SettingsSection | null {
  try {
    const value = window.sessionStorage.getItem(REOPEN_SETTINGS_KEY);
    window.sessionStorage.removeItem(REOPEN_SETTINGS_KEY);
    return isSettingsSection(value) ? value : null;
  } catch {
    return null;
  }
}
