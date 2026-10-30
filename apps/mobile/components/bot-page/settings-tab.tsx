import {
  botModelKey,
  connectedModelOptions,
  defaultModelLabel,
  parseModelOptionKey,
} from "@rakazo/core";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { useComputerChoice } from "../../lib/bot-choices";
import type { BotPageContext } from "../../lib/bot-page";
import { useBotSetting, useModelCatalog } from "../../lib/bot-page";
import { useI18n } from "../../lib/i18n";
import { Group, InkSwitch, Row, SaveMeta } from "./kit";

/** How the bot behaves and where it runs: rows that open an editor, or save on change. */
export function SettingsTab({ page }: { page: BotPageContext }) {
  const { t } = useI18n();
  const router = useRouter();
  const { state } = useModelCatalog();
  const catalog = state.kind === "ready" ? state.value : null;
  const { bot } = page;
  const modelKey = botModelKey(bot);
  const model = parseModelOptionKey(modelKey);
  const modelLabel = !model
    ? catalog
      ? defaultModelLabel(catalog, {
          default: t("Default"),
          auto: t("Auto"),
          fixed: t("Space default"),
        })
      : t("Space default")
    : ((catalog &&
        connectedModelOptions(catalog.credentials, catalog.catalog).find(
          (option) => option.key === modelKey,
        )?.label) ??
      model.modelId);
  const open = (pathname: "/bot-text" | "/bot-model" | "/bot-voice", field?: string) =>
    router.push({ pathname, params: { botId: bot.id, ...(field ? { field } : {}) } });

  return (
    <View style={{ gap: 28 }}>
      <Group label={t("How it behaves")}>
        <TextRow
          page={page}
          field="instructions"
          onOpen={() => open("/bot-text", "instructions")}
        />
        <TextRow page={page} field="description" onOpen={() => open("/bot-text", "description")} />
        <Row label={t("Model")} value={modelLabel} chevron onPress={() => open("/bot-model")} />
        <Row label={t("Voice and replies")} chevron onPress={() => open("/bot-voice")} />
      </Group>
      <Group label={t("How it runs")}>
        <ComputerRow page={page} />
        <NotificationsRow page={page} />
      </Group>
    </View>
  );
}

/**
 * A long text opened in its own editor. The row previews it, and says when its
 * save failed after the editor closed; Retry lives in the editor.
 */
function TextRow({
  page,
  field,
  onOpen,
}: {
  page: BotPageContext;
  field: "instructions" | "description";
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const save = useBotSetting(page, field);
  const failed = save.state.kind === "failed";
  const text = save.draft?.value ?? save.value;
  return (
    <Row
      label={field === "instructions" ? t("Instructions") : t("Description")}
      subline={
        save.state.kind === "failed"
          ? save.state.reason || t("Could not save")
          : text.trim() || null
      }
      sublineTone={failed ? "destructive" : "muted"}
      sublineLines={2}
      chevron
      onPress={onOpen}
    />
  );
}

function ComputerRow({ page }: { page: BotPageContext }) {
  const router = useRouter();
  const choice = useComputerChoice(page);
  return (
    <Row
      label={choice.title}
      subline={choice.note}
      meta={<SaveMeta state={choice.save.state} onRetry={() => void choice.save.retry()} />}
      value={choice.selected?.label}
      chevron
      disabled={choice.disabled}
      onPress={() =>
        router.push({ pathname: "/bot-choice", params: { botId: page.bot.id, kind: "computer" } })
      }
    />
  );
}

function NotificationsRow({ page }: { page: BotPageContext }) {
  const { t } = useI18n();
  const notify = useBotSetting(page, "notifyOnFinish");
  return (
    <Row
      label={t("Notifications")}
      meta={<SaveMeta state={notify.state} onRetry={notify.retry} />}
      control={
        <InkSwitch
          accessibilityLabel={t("Notifications")}
          value={notify.value}
          disabled={page.readOnly}
          onValueChange={(value) => void notify.save(value)}
        />
      }
    />
  );
}
