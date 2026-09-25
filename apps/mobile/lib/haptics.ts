import * as Haptics from "expo-haptics";

/** A light tap under the finger when a message goes out or a run is stopped.
 * Best effort: devices without a haptic engine, or with system haptics off,
 * simply feel nothing. */
export function commitHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/** The lighter tick for a control that only opens a choice (attach). */
export function selectionHaptic(): void {
  void Haptics.selectionAsync().catch(() => undefined);
}
