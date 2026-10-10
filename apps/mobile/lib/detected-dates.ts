import type { CalendarEvent, DateLinks, DetectedDate } from "@rakazo/chat-ui/native";
import { eventForDate } from "@rakazo/chat-ui/native";
import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { selectionHaptic } from "./haptics";

type RakazoDates = {
  find(text: string): DetectedDate[];
  addEvent(event: CalendarEvent): Promise<boolean>;
};

// iOS only: Android, and an app built before this module, simply show no dates.
const native =
  Platform.OS === "ios" ? requireOptionalNativeModule<RakazoDates>("RakazoDates") : null;

const CACHE_LIMIT = 300;

/** The dates the device finds in bubbles, or null where it has no detector. A
 * thread re-renders its bubbles often; each text is read once. */
export function createDateLinks(accessibilityHint: string): DateLinks | null {
  if (!native) return null;
  const detector = native;
  const found = new Map<string, DetectedDate[]>();
  return {
    accessibilityHint,
    find(text) {
      let dates = found.get(text);
      if (!dates) {
        dates = detector.find(text);
        if (found.size >= CACHE_LIMIT) found.clear();
        found.set(text, dates);
      }
      return dates;
    },
    open(date, text) {
      selectionHaptic();
      void detector.addEvent(eventForDate(date, text)).catch(() => undefined);
    },
  };
}
