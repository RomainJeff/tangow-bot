import type { Routine } from "@rakazo/contracts";
import { routineFailing } from "@rakazo/core";
import { Pressable, StyleSheet, View } from "react-native";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { type BotPageContext, useBotField } from "../../lib/bot-page";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../../lib/native";
import { cadenceLine, routinesSummary } from "../../lib/routine-copy";
import { NativeSymbol } from "../native-symbol";
import { Group, InkSwitch, LoadFailed, LoadingRows, Row, SaveMeta, useFocusedRead } from "./kit";

type Write = ReturnType<typeof useFocusedRead<Routine[]>>["write"];

/**
 * The bot's routines: one row each, its switch apart from the row that opens it.
 * `epoch` changes when a run ends: a run may have changed a routine or how it last went.
 */
export function RoutinesTab({
  page,
  epoch,
  onOpen,
  onCreate,
}: {
  page: BotPageContext;
  epoch: number;
  onOpen: (routine: Routine) => void;
  onCreate: () => void;
}) {
  const { t } = useI18n();
  const botId = page.bot.id;
  const { read, write, retry } = useFocusedRead(
    () => rpc<Routine[]>("routines/list", { botId }),
    [botId, epoch],
  );
  if (read.kind === "loading") {
    return (
      <Group>
        <LoadingRows />
      </Group>
    );
  }
  if (read.kind === "failed") return <LoadFailed onRetry={retry} />;
  const routines = read.value;
  if (routines.length === 0) {
    return (
      <Group>
        <Row label={t("New routine")} disabled={page.readOnly} onPress={onCreate} chevron />
      </Group>
    );
  }
  return (
    <Group
      label={routinesSummary(routines)}
      trailing={page.readOnly ? null : <AddButton label={t("New routine")} onPress={onCreate} />}
    >
      {routines.map((routine) => (
        <RoutineRow
          key={routine.id}
          page={page}
          routine={routine}
          write={write}
          onOpen={() => onOpen(routine)}
        />
      ))}
    </Group>
  );
}

function RoutineRow({
  page,
  routine,
  write,
  onOpen,
}: {
  page: BotPageContext;
  routine: Routine;
  write: Write;
  onOpen: () => void;
}) {
  const styles = useThemedStyles(createRoutineStyles);
  const { t } = useI18n();
  const active = useBotField(
    page,
    `routine:${routine.id}:active`,
    routine.active,
    async (value) => {
      const settle = write();
      const saved = await rpc<Routine>("routines/update", { routineId: routine.id, active: value });
      settle((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              value: current.value.map((item) => (item.id === saved.id ? saved : item)),
            }
          : current,
      );
    },
  );
  const shown = { ...routine, active: active.value };
  const state = !shown.active ? "paused" : routineFailing(shown) ? "failed" : "ok";
  const stateLabel = { paused: t("Paused"), failed: t("Last run failed"), ok: t("Active") }[state];
  return (
    <Row
      label={routine.name}
      subline={cadenceLine(shown)}
      sublineLines={2}
      accessibilityLabel={`${routine.name}, ${stateLabel}`}
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
