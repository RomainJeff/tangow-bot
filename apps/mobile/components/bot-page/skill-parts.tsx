import type { SkillVersion } from "@rakazo/contracts";
import { skillVersionSubline, threadTimeMarkerLabel } from "@rakazo/core";
import { Pressable } from "react-native";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { NativeSymbol } from "../native-symbol";

/** "Today 14:02", "Yesterday 09:30", then the weekday and date. */
export function useDateLabel(): (iso: string) => string {
  const { t } = useI18n();
  return (iso) =>
    threadTimeMarkerLabel(iso, {
      locale: dateLocaleForUi(),
      today: t("Today"),
      yesterday: t("Yesterday"),
    });
}

/** "Scout · learned", "You · updated · Undone": who wrote a version and what it did. */
export function useVersionSubline(): (version: SkillVersion) => string {
  const { t } = useI18n();
  return (version) =>
    skillVersionSubline(version, {
      learned: t("learned"),
      updated: t("updated"),
      you: t("You"),
      unknown: t("Updated"),
      undone: t("Undone"),
    });
}

/** The header's `⋯`, which opens the screen's native action sheet. */
export function MoreButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={10} onPress={onPress}>
      <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
    </Pressable>
  );
}
