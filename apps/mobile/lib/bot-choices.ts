import type { ComputerMode, ThinkingLevel } from "@rakazo/contracts";
import {
  botModelKey,
  catalogLabel,
  connectedModelOptions,
  parseModelOptionKey,
  thinkingChoices,
} from "@rakazo/core";
import {
  type BotPageContext,
  type BotPatch,
  type FieldSave,
  setBotComputer,
  updateBot,
  useBotField,
  useBotSetting,
  useModelCatalog,
  useVoices,
} from "./bot-page";
import { t } from "./i18n";
import { thinkingLevelLabel } from "./thinking-level";

/**
 * One bot setting picked from a list, as the row that shows it and the list screen that
 * changes it both read it. An option's `id` is its place in `options`.
 */
export type BotChoice = {
  title: string;
  options: Array<{ id: string; label: string }>;
  /** The option holding the value now, or the one being saved. */
  selected: { id: string; label: string } | undefined;
  save: Pick<FieldSave<unknown>, "state" | "retry">;
  disabled: boolean;
  /** Why the list cannot be changed right now, said under it. */
  note: string | null;
  /** Saves the option unless it is the value already; true once the value holds. */
  choose: (id: string) => Promise<boolean>;
  /** Whether what the options come from is read. */
  load: ChoiceLoad;
};

/**
 * A failed read with a `reason` still lists what it can (the Model list keeps Space default);
 * without one, there is nothing to pick until Retry.
 */
export type ChoiceLoad =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "failed"; reason: string | null; retry: () => void };

function choiceOf<V>(
  title: string,
  field: FieldSave<V>,
  options: Array<{ value: NoInfer<V>; label: string }>,
  {
    disabled,
    note = null,
    load = { kind: "ready" },
  }: { disabled: boolean; note?: string | null; load?: ChoiceLoad },
): BotChoice {
  const listed = options.map((option, index) => ({ id: String(index), label: option.label }));
  return {
    title,
    options: listed,
    selected: listed[options.findIndex((option) => option.value === field.value)],
    save: field,
    disabled: disabled || note !== null || field.state.kind === "saving",
    note,
    load,
    choose: async (id) => {
      const option = options[Number(id)];
      if (!option) return true;
      if (option.value === field.value) {
        // Keeping the value drops a failed save of another one, so its Retry cannot send it later.
        if (field.current().kind === "failed") field.dismiss();
        return true;
      }
      await field.save(option.value);
      return field.current().kind !== "failed";
    },
  };
}

export const BOT_CHOICE_KINDS = ["computer", "model", "thinking", "voice", "memoryScope"] as const;
export type BotChoiceKind = (typeof BOT_CHOICE_KINDS)[number];

export function isBotChoiceKind(value: unknown): value is BotChoiceKind {
  return BOT_CHOICE_KINDS.includes(value as BotChoiceKind);
}

export function useComputerChoice(page: BotPageContext): BotChoice {
  const { bot, readOnly } = page;
  const computer = useBotField<ComputerMode>(page, "computerMode", bot.computerMode, (mode) =>
    setBotComputer(bot.id, mode),
  );
  return choiceOf(
    t("Computer"),
    computer,
    [
      { value: "team", label: t("Team") },
      { value: "dedicated", label: t("Private") },
    ],
    {
      disabled: readOnly,
      note: bot.status !== "idle" ? t("Available when {name} is idle", { name: bot.name }) : null,
    },
  );
}

/** What a model choice writes; a new model has its own thinking levels, so the old one goes. */
export function modelPatch(key: string): BotPatch {
  const selected = parseModelOptionKey(key);
  return {
    modelProvider: selected?.provider ?? null,
    modelId: selected?.modelId ?? null,
    thinkingLevel: null,
  };
}

/** The model and thinking level, read together: a new model has its own levels. */
export function useModelFields(page: BotPageContext) {
  const { bot } = page;
  const { state, retry } = useModelCatalog();
  const catalog = state.kind === "ready" ? state.value : null;
  const model = useBotField(page, "model", botModelKey(bot), (key) =>
    updateBot(bot.id, modelPatch(key)),
  );
  const thinking = useBotField<ThinkingLevel | "">(
    page,
    "thinkingLevel",
    bot.thinkingLevel ?? "",
    (level) => updateBot(bot.id, { thinkingLevel: level || null }),
  );
  const load: ChoiceLoad =
    state.kind === "failed" ? { kind: "failed", reason: null, retry } : { kind: state.kind };
  return { catalog, load, model, thinking };
}

type ModelFields = ReturnType<typeof useModelFields>;

export function modelChoice(
  page: BotPageContext,
  { catalog, load, model }: ModelFields,
): BotChoice {
  const options = catalog ? connectedModelOptions(catalog.credentials, catalog.catalog) : [];
  const me = catalog?.me;
  const spaceDefault = me?.defaultModel
    ? `${t("Space default")} (${catalogLabel(catalog?.catalog ?? [], me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
    : t("Space default");
  return choiceOf(
    t("Model"),
    model,
    [
      { value: "", label: spaceDefault },
      ...(model.value && !options.some((option) => option.key === model.value)
        ? [{ value: model.value, label: parseModelOptionKey(model.value)?.modelId ?? model.value }]
        : []),
      ...options.map((option) => ({ value: option.key, label: option.label })),
    ],
    {
      disabled: page.readOnly,
      load: load.kind === "failed" ? { ...load, reason: t("Could not load model settings") } : load,
    },
  );
}

/** `null` once the catalog is read and the model offers no thinking levels. */
export function thinkingChoice(
  page: BotPageContext,
  { catalog, load, model, thinking }: ModelFields,
): BotChoice | null {
  const { levels, fallback } = catalog
    ? thinkingChoices(catalog, model.value)
    : { levels: [], fallback: "medium" as const };
  if (catalog && levels.length === 0) return null;
  return choiceOf(
    t("Thinking"),
    thinking,
    catalog
      ? [
          { value: "", label: t("Default ({level})", { level: thinkingLevelLabel(fallback) }) },
          ...levels.map((level) => ({ value: level, label: thinkingLevelLabel(level) })),
        ]
      : [],
    { disabled: page.readOnly, load },
  );
}

/** `null` once the voices are read and there are none. */
export function useVoiceChoice(page: BotPageContext): BotChoice | null {
  const { state, retry } = useVoices();
  const voice = useBotSetting(page, "voiceId");
  const voices = state.kind === "ready" ? state.value : [];
  if (state.kind === "ready" && voices.length === 0) return null;
  return choiceOf(
    t("Voice"),
    voice,
    state.kind === "ready"
      ? [
          { value: null, label: t("Account default") },
          ...voices.map((item) => ({ value: item.id, label: item.label })),
        ]
      : [],
    {
      disabled: page.readOnly,
      load:
        state.kind === "failed" ? { kind: "failed", reason: null, retry } : { kind: state.kind },
    },
  );
}

export function useMemoryScopeChoice(page: BotPageContext): BotChoice {
  return choiceOf(
    t("Memory scope"),
    useBotSetting(page, "memoryScope"),
    [
      { value: null, label: t("Inherit default") },
      { value: "isolated", label: t("Isolated") },
      { value: "shared", label: t("Shared") },
    ],
    { disabled: page.readOnly },
  );
}

function useModelChoice(page: BotPageContext): BotChoice {
  return modelChoice(page, useModelFields(page));
}

function useThinkingChoice(page: BotPageContext): BotChoice | null {
  return thinkingChoice(page, useModelFields(page));
}

/** Each list screen's choice, by the `kind` it is opened with. */
export const BOT_CHOICES: Record<BotChoiceKind, (page: BotPageContext) => BotChoice | null> = {
  computer: useComputerChoice,
  model: useModelChoice,
  thinking: useThinkingChoice,
  voice: useVoiceChoice,
  memoryScope: useMemoryScopeChoice,
};
