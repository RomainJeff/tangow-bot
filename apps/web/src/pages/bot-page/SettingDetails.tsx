import { useLingui } from "@lingui/react/macro";
import type { ThinkingLevel } from "@rakazo/contracts";
import { BOT_DESCRIPTION_MAX_LENGTH, BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import {
  botModelKey,
  connectedModelOptions,
  defaultModelLabel,
  parseModelOptionKey,
  thinkingChoices,
} from "@rakazo/core";
import {
  NativeSelect,
  NativeSelectOption,
  SaveMeta,
  SettingRow,
  Switch,
  TextSettingField,
} from "@rakazo/ui-web";
import type { FocusEvent } from "react";
import { useId, useRef } from "react";
import { thinkingLevelLabel, useModelCatalog, useVoices } from "./model-options";
import type { BotPageContext } from "./page-kit";
import { SettingsGroup, useBotField, useSaveLabels } from "./page-kit";

/** Instructions or Description, edited at full height in the wide panel. */
export function TextDetail({
  page,
  kind,
  confirm,
}: {
  page: BotPageContext;
  kind: "instructions" | "description";
  confirm: (title: string) => Promise<boolean>;
}) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const field = useBotField(page, kind, page.bot[kind], (value) =>
    kind === "instructions" ? { instructions: value } : { description: value },
  );
  const instructions = kind === "instructions";
  // Opening the editor lands the caret after the text, ready to add to it.
  const caretPlaced = useRef(false);
  const placeCaret = (event: FocusEvent<HTMLInputElement>) => {
    if (caretPlaced.current) return;
    caretPlaced.current = true;
    const end = event.currentTarget.value.length;
    event.currentTarget.setSelectionRange(end, end);
  };
  return (
    <TextSettingField
      label={
        <span className="text-title text-foreground">
          {instructions ? t`Instructions` : t`Description`}
        </span>
      }
      field={field}
      labels={labels}
      multiline
      counter
      keepDraft
      maxLength={instructions ? BOT_INSTRUCTIONS_MAX_LENGTH : BOT_DESCRIPTION_MAX_LENGTH}
      onConfirmClear={() => confirm(instructions ? t`Clear instructions?` : t`Clear description?`)}
      placeholder={instructions ? t`How this bot should behave` : t`What this bot is for`}
      autoFocus
      onFocus={placeCaret}
      dir="auto"
      data-testid={instructions ? "bot-instructions" : "bot-description"}
      className="min-h-0 flex-1 gap-3 px-6 pt-1 pb-4"
      controlClassName="min-h-0 flex-1 resize-none rounded-block border-transparent bg-group px-5 py-4.5 text-question shadow-group field-sizing-fixed md:text-question dark:bg-group"
    />
  );
}

/** The model the bot runs and how hard it thinks; each choice saves when picked. */
export function ModelDetail({ page }: { page: BotPageContext }) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const ids = useId();
  const catalog = useModelCatalog();
  const { bot } = page;
  const model = useBotField(page, "model", botModelKey(bot), (key) => {
    const selected = parseModelOptionKey(key);
    return {
      modelProvider: selected?.provider ?? null,
      modelId: selected?.modelId ?? null,
      // A new model has its own thinking levels; clear the old one only once they are known.
      ...(catalog.ready ? { thinkingLevel: null } : {}),
    };
  });
  const thinking = useBotField<ThinkingLevel | "">(
    page,
    "thinkingLevel",
    bot.thinkingLevel ?? "",
    (level) => ({
      thinkingLevel: level || null,
    }),
  );
  const options = connectedModelOptions(catalog.credentials, catalog.catalog);
  const { levels, fallback } = thinkingChoices(catalog, model.value);

  return (
    <div className="flex flex-col gap-5 px-6 pt-1 pb-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`${ids}-model`} className="text-title text-foreground">
            {t`Model`}
          </label>
          <SaveMeta state={model.state} labels={labels} onRetry={model.retry} />
        </div>
        <NativeSelect
          id={`${ids}-model`}
          className="w-full"
          value={model.value}
          onChange={(event) => void model.save(event.target.value)}
        >
          <NativeSelectOption value="">
            {defaultModelLabel(catalog, {
              default: t`Default`,
              auto: t`Auto`,
              fixed: t`Space default`,
            })}
          </NativeSelectOption>
          {model.value && !options.some((option) => option.key === model.value) ? (
            <NativeSelectOption value={model.value}>
              {parseModelOptionKey(model.value)?.modelId ?? model.value}
            </NativeSelectOption>
          ) : null}
          {options.map((option) => (
            <NativeSelectOption key={option.key} value={option.key}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {levels.length ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={`${ids}-thinking`} className="text-meta text-muted-foreground">
              {t`Thinking`}
            </label>
            <SaveMeta state={thinking.state} labels={labels} onRetry={thinking.retry} />
          </div>
          <NativeSelect
            id={`${ids}-thinking`}
            className="w-full"
            value={thinking.value}
            onChange={(event) => void thinking.save(event.target.value as ThinkingLevel | "")}
          >
            <NativeSelectOption value="">
              {t`Default (${thinkingLevelLabel(fallback)})`}
            </NativeSelectOption>
            {levels.map((level) => (
              <NativeSelectOption key={level} value={level}>
                {thinkingLevelLabel(level)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      ) : null}
    </div>
  );
}

/** The voice the bot speaks with and how it replies; each control saves on change. */
export function VoiceDetail({ page }: { page: BotPageContext }) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const voices = useVoices();
  const { bot } = page;
  const voice = useBotField(page, "voiceId", bot.voiceId ?? "", (value) => ({
    voiceId: value || null,
  }));
  const autoSpeak = useBotField(page, "autoSpeak", bot.autoSpeak, (value) => ({
    autoSpeak: value,
  }));
  const chatty = useBotField(page, "chattyReplies", bot.chattyReplies, (value) => ({
    chattyReplies: value,
  }));
  return (
    <div className="flex flex-col gap-5 px-6 pt-1 pb-4">
      <h2 className="text-title text-foreground">{t`Voice and replies`}</h2>
      <SettingsGroup>
        {voices.length ? (
          <SettingRow
            label={t`Voice`}
            meta={<SaveMeta state={voice.state} labels={labels} onRetry={voice.retry} />}
          >
            <NativeSelect
              aria-label={t`Voice`}
              size="sm"
              value={voice.value}
              onChange={(event) => void voice.save(event.target.value)}
            >
              <NativeSelectOption value="">{t`Account default`}</NativeSelectOption>
              {voices.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </SettingRow>
        ) : null}
        <SettingRow
          label={t`Read replies aloud`}
          meta={<SaveMeta state={autoSpeak.state} labels={labels} onRetry={autoSpeak.retry} />}
        >
          <Switch
            aria-label={t`Read replies aloud`}
            checked={autoSpeak.value}
            onCheckedChange={(checked) => void autoSpeak.save(checked)}
          />
        </SettingRow>
        <SettingRow
          label={t`Reply in several short messages`}
          meta={<SaveMeta state={chatty.state} labels={labels} onRetry={chatty.retry} />}
        >
          <Switch
            aria-label={t`Reply in several short messages`}
            checked={chatty.value}
            onCheckedChange={(checked) => void chatty.save(checked)}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
