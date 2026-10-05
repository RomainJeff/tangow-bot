import * as Haptics from "expo-haptics";

/** A light tap under the finger when a run is stopped.
 * Best effort: devices without a haptic engine, or with system haptics off,
 * simply feel nothing. */
export function commitHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/** The softer tap for sending a message (was `commitHaptic`). */
export function sendHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => undefined);
}

/** The lighter tick for a control that only opens a choice (attach). */
export function selectionHaptic(): void {
  void Haptics.selectionAsync().catch(() => undefined);
}

/** Tap on the composer's mic, entering dictation (`.light`). */
export function dictateHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/** ✓ Insert dictation (`.success`) — the text lands in the draft,
 * nothing is sent yet. */
export function insertHaptic(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}

/** A server confirmation the person should feel: my reaction landed (7d), or
 * a decision card just settled (7e). Never for someone else's reaction, and
 * never on a failed call. */
export function successHaptic(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
}
