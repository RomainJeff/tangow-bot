import type { Routine } from "@rakazo/contracts";
import { routineFailing } from "@rakazo/core";
import { StyleSheet, View } from "react-native";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { type BotPageContext, useBotField } from "../../lib/bot-page";
import { useI18n } from "../../lib/i18n";
import { useThemedStyles } from "../../lib/native";
import { cadenceLine, routinesSummary } from "../../lib/routine-copy";
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

type Write = ReturnType<typeof useFocusedRead<Routine[]>>["write"];

/**
 * The bot's routines: one row each, its switch apart from the row that opens it.
 * `epoch` changes when a run ends: a run may have changed a routine or how it last went.
 */
export function RoutinesTab({
  page,
  epoch,
  onOpen,
}: {
  page: BotPageContext;
  epoch: number;
  onOpen: (routine: Routine) => void;
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
  if (routines.length === 0) return <QuietLine>{t("No routines yet")}</QuietLine>;
  return (
    <Group label={routinesSummary(routines)}>
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

function createRoutineStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    dot: { width: 8, height: 8, borderRadius: 4 },
    ok: { backgroundColor: tokens.success },
    failed: { backgroundColor: tokens.destructive },
    paused: { backgroundColor: tokens.input },
  });
}
