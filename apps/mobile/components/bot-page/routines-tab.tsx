import type { Routine } from "@rakazo/contracts";
import { routineFailing } from "@rakazo/core";
import { Pressable, StyleSheet, View } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import {
  type BotPageContext,
  readRoutines,
  updateRoutine,
  useBotField,
  useRoutineList,
} from "../../lib/bot-page";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../../lib/native";
import { cadenceLine, routinesSummary } from "../../lib/routine-copy";
import { NativeSymbol } from "../native-symbol";
import {
  Group,
  InkSwitch,
  LoadFailed,
  LoadingRows,
  QuietLine,
  Row,
  SaveMeta,
  useFocusedRead,
} from "./kit";
import { EDITS_TRIGGERS } from "./when-to-run";

/**
 * The bot's routines from the copy every screen shares, read again on focus and when `epoch`
 * moves. `read` is this screen's own read: "ready" once one has answered since it opened.
 */
export function useRoutines(botId: string, epoch: number) {
  const { read, retry } = useFocusedRead(() => readRoutines(botId), [botId, epoch]);
  return { routines: useRoutineList(botId), read: read.kind, retry };
}

/**
 * The bot's routines: one row each, its switch apart from the row that opens it. `list` is the
 * page's read, which also tells the tab bar whether a routine failed.
 * Where triggers cannot be edited, a new routine could never get one, so none is offered.
 */
export function RoutinesTab({
  page,
  list: { routines, read, retry },
  onOpen,
  onCreate,
}: {
  page: BotPageContext;
  list: ReturnType<typeof useRoutines>;
  onOpen: (routine: Routine) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  if (!routines) {
    if (read === "failed") return <LoadFailed onRetry={retry} />;
    return (
      <Group>
        <LoadingRows />
      </Group>
    );
  }
  const creates = EDITS_TRIGGERS && !page.readOnly;
  if (routines.length === 0) {
    if (!EDITS_TRIGGERS) return <QuietLine>{t("No routines yet")}</QuietLine>;
    return (
      <Group>
        <Row label={t("New routine")} disabled={page.readOnly} onPress={onCreate} chevron />
      </Group>
    );
  }
  return (
    <Group
      label={routinesSummary(routines)}
      trailing={creates ? <AddButton label={t("New routine")} onPress={onCreate} /> : null}
    >
      {routines.map((routine) => (
        <RoutineRow key={routine.id} page={page} routine={routine} onOpen={() => onOpen(routine)} />
      ))}
    </Group>
  );
}

function RoutineRow({
  page,
  routine,
  onOpen,
}: {
  page: BotPageContext;
  routine: Routine;
  onOpen: () => void;
}) {
  const styles = useThemedStyles(createRoutineStyles);
  const { t } = useI18n();
  const active = useBotField(page, `routine:${routine.id}:active`, routine.active, (value) =>
    updateRoutine(page.bot.id, routine.id, { active: value }),
  );
  const shown = { ...routine, active: active.value };
  const state = !shown.active ? "paused" : routineFailing(shown) ? "failed" : "ok";
  const stateLabel = { paused: t("Paused"), failed: t("Last run failed"), ok: t("Active") }[state];
  const cadence = cadenceLine(shown);
  return (
    <Row
      label={routine.name}
      subline={cadence}
      sublineLines={2}
      accessibilityLabel={`${routine.name}, ${stateLabel}, ${cadence}`}
      leading={<View style={[styles.dot, styles[state]]} />}
      meta={<SaveMeta state={active.state} onRetry={active.retry} />}
      onPress={onOpen}
      control={
        <InkSwitch
          accessibilityLabel={t("Active: {name}", { name: routine.name })}
          value={active.value}
          disabled={page.readOnly}
          onValueChange={(value) => void active.save(value)}
        />
      }
    />
  );
}

/** A round "+" on the group label's line, centred on it since a view has no text baseline. */
function AddButton({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useThemedStyles(createRoutineStyles);
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.add, pressed && styles.addPressed]}
    >
      <NativeSymbol
        ios="plus"
        android="add"
        size={15}
        weight="semibold"
        color={tokens.foreground}
      />
    </Pressable>
  );
}

function createRoutineStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    dot: { width: 8, height: 8, borderRadius: 4 },
    ok: { backgroundColor: tokens.success },
    failed: { backgroundColor: tokens.destructive },
    paused: { backgroundColor: tokens.input },
    // Negative margins keep the label line's height, so the circle never reaches the card below.
    add: {
      alignSelf: "center",
      marginVertical: -5,
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.secondary,
    },
    addPressed: { opacity: 0.6 },
  });
}
