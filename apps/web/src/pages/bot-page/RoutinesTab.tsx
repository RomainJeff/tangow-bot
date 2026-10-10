import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { routineFailing, saveKey } from "@rakazo/core";
import { Button, type FieldSave, SaveMeta, SettingRow, Switch, useFieldSave } from "@rakazo/ui-web";
import { Plus } from "lucide-react";
import type { BotDetail } from "../shell/layout";
import { type BotPageContext, SettingsGroup, useSaveLabels } from "./page-kit";
import { useRoutineCopy } from "./routine-copy";

/** Whether a routine is on, saved the moment it is switched. */
export function useRoutineActive(page: BotPageContext, routine: Routine): FieldSave<boolean> {
  const { bot, userId, commands } = page;
  return useFieldSave({
    key: saveKey({ userId, spaceId: bot.spaceId }, bot.id, `routine:${routine.id}:active`),
    serverValue: routine.active,
    commit: async (active) => {
      await commands.updateRoutine(bot.id, routine.id, { active });
    },
  });
}

/** The bot's routines: one row each, its switch apart from the row that opens it. */
export function RoutinesTab({
  page,
  routines,
  onOpen,
}: {
  page: BotPageContext;
  /** `null` until this bot's routines are read. */
  routines: Routine[] | null;
  onOpen: (detail: BotDetail) => void;
}) {
  const { t } = useLingui();
  const copy = useRoutineCopy();
  const create = () => onOpen({ kind: "routine-new" });

  if (routines === null) return null;

  if (routines.length === 0) {
    return (
      <SettingsGroup>
        <SettingRow
          data-testid="routine-create-button"
          data-opens="routine-new"
          onClick={create}
          label={
            <span className="flex items-center gap-3">
              <Plus className="size-4 text-muted-foreground" aria-hidden />
              {t`New routine`}
            </span>
          }
        />
      </SettingsGroup>
    );
  }

  return (
    <section className="flex flex-col gap-1.5" data-testid="bot-routines">
      <div className="mx-3.5 flex items-baseline justify-between gap-3">
        <h2 className="text-label text-muted-foreground">{copy.listSummary(routines)}</h2>
        <Button
          variant="roundIconSecondary"
          size="roundIconSm"
          className="-me-1 self-center"
          aria-label={t`New routine`}
          data-testid="routine-create-button"
          data-opens="routine-new"
          onClick={create}
        >
          <Plus aria-hidden />
        </Button>
      </div>
      <SettingsGroup>
        {routines.map((routine) => (
          <RoutineRow
            key={routine.id}
            page={page}
            routine={routine}
            onOpen={() => onOpen({ kind: "routine", routineId: routine.id })}
          />
        ))}
      </SettingsGroup>
    </section>
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
  const { t } = useLingui();
  const copy = useRoutineCopy();
  const labels = useSaveLabels();
  const active = useRoutineActive(page, routine);
  const shown = { ...routine, active: active.value };
  const state = !shown.active ? "paused" : routineFailing(shown) ? "failed" : "ok";
  const stateLabel = { paused: t`Paused`, failed: t`Last run failed`, ok: t`Active` }[state];
  const dot = { paused: "bg-input", failed: "bg-destructive", ok: "bg-success" }[state];
  return (
    <div className="flex items-center gap-3 pe-3.5">
      <SettingRow
        data-opens={`routine:${routine.id}`}
        onClick={onOpen}
        className="min-w-0 flex-1 self-stretch pe-0"
        label={
          <span className="flex items-center gap-2">
            <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
            <span className="sr-only">{stateLabel}</span>
            <span className="truncate" dir="auto">
              {routine.name}
            </span>
          </span>
        }
        subline={<span className="block truncate ps-4">{copy.cadenceLine(shown)}</span>}
      />
      <SaveMeta state={active.state} labels={labels} onRetry={active.retry} />
      <Switch
        aria-label={t`Active: ${routine.name}`}
        checked={active.value}
        onCheckedChange={(checked) => void active.save(checked)}
      />
    </div>
  );
}
