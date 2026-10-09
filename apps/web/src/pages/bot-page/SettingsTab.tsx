import { useLingui } from "@lingui/react/macro";
import type { ComputerMode } from "@rakazo/contracts";
import { saveKey } from "@rakazo/core";
import { SaveMeta, SegmentedControl, SettingRow, Switch, useFieldSave } from "@rakazo/ui-web";
import type { BotDetail } from "../shell/layout";
import { botModelKey, modelSummary, useModelCatalog, useVoices } from "./model-options";
import { type BotPageContext, SettingsGroup, useBotField, useSaveLabels } from "./page-kit";

/** How the bot behaves and where it runs: rows that open an editor, or save on change. */
export function SettingsTab({
  page,
  onOpen,
}: {
  page: BotPageContext;
  onOpen: (detail: BotDetail) => void;
}) {
  const { t } = useLingui();
  const { bot } = page;
  const catalog = useModelCatalog();
  const voices = useVoices();
  const voiceLabel = voices.find((voice) => voice.id === bot.voiceId)?.label;

  return (
    <div data-testid="bot-settings" className="flex flex-col gap-6">
      <SettingsGroup label={t`How it behaves`}>
        <TextRow page={page} label={t`Instructions`} opens="instructions" onOpen={onOpen} />
        <TextRow page={page} label={t`Description`} opens="description" onOpen={onOpen} />
        <SettingRow
          label={t`Model`}
          subline={modelSummary(catalog, botModelKey(bot))}
          chevron
          data-opens="model"
          onClick={() => onOpen({ kind: "model" })}
          className={ROW}
        />
        <SettingRow
          label={t`Voice and replies`}
          subline={voiceLabel ?? t`Account default`}
          chevron
          data-opens="voice"
          onClick={() => onOpen({ kind: "voice" })}
          className={ROW}
        />
      </SettingsGroup>
      <SettingsGroup label={t`How it runs`}>
        <ComputerRow page={page} />
        <NotificationsRow page={page} />
      </SettingsGroup>
    </div>
  );
}

const ROW = "min-h-12.5 rounded-none ps-3.5";

/**
 * A long text opened in its own editor. The row previews it, and says when its
 * save is still running or failed after the editor closed; Retry lives in the editor.
 */
function TextRow({
  page,
  label,
  opens,
  onOpen,
}: {
  page: BotPageContext;
  label: string;
  opens: "instructions" | "description";
  onOpen: (detail: BotDetail) => void;
}) {
  const labels = useSaveLabels();
  const field = useBotField(page, opens, page.bot[opens], (value) =>
    opens === "instructions" ? { instructions: value } : { description: value },
  );
  const text = field.state.kind === "failed" ? field.state.value : field.value;
  const subline =
    field.state.kind === "failed" ? (
      <span className="text-destructive">{labels.failed}</span>
    ) : text ? (
      <span className="line-clamp-2 whitespace-pre-line">{text}</span>
    ) : undefined;
  return (
    <SettingRow
      label={label}
      subline={subline}
      chevron
      data-opens={opens}
      onClick={() => onOpen({ kind: opens })}
      className={ROW}
    />
  );
}

function ComputerRow({ page }: { page: BotPageContext }) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const { bot, userId, commands } = page;
  const computer = useFieldSave<ComputerMode>({
    key: saveKey({ userId, spaceId: bot.spaceId }, bot.id, "computerMode"),
    serverValue: bot.computerMode,
    commit: async (mode) => {
      await commands.setComputer(bot.id, mode);
    },
  });
  const busy = bot.status !== "idle";
  // A refused change puts the previous choice back and says why; picking again retries.
  const failed = computer.state.kind === "failed" && computer.state.reason;
  const subline = busy ? (
    t`Available when ${bot.name} is idle`
  ) : failed ? (
    <span className="text-destructive">{failed}</span>
  ) : undefined;
  return (
    <SettingRow
      label={t`Computer`}
      subline={subline}
      meta={
        failed ? undefined : (
          <SaveMeta state={computer.state} labels={labels} onRetry={computer.retry} />
        )
      }
      className={ROW}
    >
      <SegmentedControl
        aria-label={t`Computer`}
        value={computer.value}
        options={[
          { value: "team", label: t`Team` },
          { value: "dedicated", label: t`Private` },
        ]}
        disabled={busy || computer.state.kind === "saving"}
        onValueChange={(mode) => void computer.save(mode)}
      />
    </SettingRow>
  );
}

function NotificationsRow({ page }: { page: BotPageContext }) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const notify = useBotField(page, "notifyOnFinish", page.bot.notifyOnFinish, (value) => ({
    notifyOnFinish: value,
  }));
  return (
    <SettingRow
      label={t`Notifications`}
      meta={<SaveMeta state={notify.state} labels={labels} onRetry={notify.retry} />}
      className={ROW}
    >
      <Switch
        aria-label={t`Notifications`}
        checked={notify.value}
        onCheckedChange={(checked) => void notify.save(checked)}
      />
    </SettingRow>
  );
}
