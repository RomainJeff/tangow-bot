import { useLingui } from "@lingui/react/macro";
import type { ModelCategory, ThinkingLevel } from "@rakazo/contracts";
import { connectedModelOptions, parseModelOptionKey, thinkingChoices } from "@rakazo/core";
import { ModelThinkingOptions, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useId, useState } from "react";
import { rpc } from "../../lib/rpc";
import { thinkingLevelLabel } from "../bot-page/model-options";
import { ModelPicker } from "./model-picker";
import type { ModelSettings } from "./use-model-settings";

export function RoutingSettings({ settings }: { settings: ModelSettings }) {
  const { t } = useLingui();
  const id = useId();
  const [saving, setSaving] = useState(false);
  const { routing, catalog, credentials, me } = settings;
  const options = connectedModelOptions(credentials, catalog);
  const categories: Array<{ category: ModelCategory; label: string }> = [
    { category: "fast", label: t`Fast` },
    { category: "everyday", label: t`Everyday` },
    { category: "complex", label: t`Complex` },
  ];
  async function save(action: () => Promise<unknown>) {
    setSaving(true);
    settings.setError(null);
    try {
      await action();
      await settings.refresh();
    } catch (error) {
      settings.setError(
        error instanceof Error ? error.message : t`Could not change the default model`,
      );
    } finally {
      setSaving(false);
    }
  }
  function assign(
    category: ModelCategory,
    key: string,
    thinkingLevel: ThinkingLevel | null = null,
  ) {
    const model = parseModelOptionKey(key);
    return save(() =>
      model
        ? rpc.models.setCategory({ category, ...model, thinkingLevel })
        : rpc.models.clearCategory({ category }),
    );
  }
  return (
    <fieldset
      disabled={saving || settings.loading}
      className="mx-6 mt-5 flex min-w-0 shrink-0 flex-col gap-3 sm:mx-8"
    >
      <label htmlFor={id} className="flex flex-col gap-1.5 text-meta text-muted-foreground">
        {t`Active model`}
        <NativeSelect
          id={id}
          aria-label={t`Active model`}
          value={routing.auto ? "auto" : `${me?.defaultProvider}::${me?.defaultModel}`}
          onChange={(event) => {
            const key = event.target.value;
            void save(async () => {
              if (key === "auto") {
                await rpc.models.setAuto({ enabled: true });
                return;
              }
              const model = parseModelOptionKey(key);
              if (model) {
                await rpc.models.setAuto({ enabled: false });
                await rpc.models.setDefault(model);
              }
            });
          }}
        >
          <NativeSelectOption value="auto">{t`Auto`}</NativeSelectOption>
          {!options.some(
            (option) => option.key === `${me?.defaultProvider}::${me?.defaultModel}`,
          ) ? (
            <NativeSelectOption value={`${me?.defaultProvider}::${me?.defaultModel}`}>
              {me?.defaultModel ?? t`Deployment default`}
            </NativeSelectOption>
          ) : null}
          {options.map((option) => (
            <NativeSelectOption key={option.key} value={option.key}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {routing.auto ? (
        <div className="rounded-card bg-group shadow-group">
          {categories.map(({ category, label }) => {
            const assignment = routing.categories.find((item) => item.category === category);
            const key = assignment ? `${assignment.provider}::${assignment.modelId}` : "";
            const { levels } = thinkingChoices({ catalog, credentials, me }, key);
            return (
              <section
                key={category}
                aria-label={label}
                className="flex flex-col gap-2 border-b border-border px-3.5 py-3 last:border-0"
              >
                <div className="text-meta text-foreground">{label}</div>
                <ModelPicker
                  ariaLabel={label}
                  value={key}
                  options={[
                    { id: "", provider: "", label: t`Default`, billing: "" },
                    ...options.map((option) => ({
                      id: option.key,
                      provider: option.provider,
                      label: option.label,
                      billing: "",
                    })),
                  ]}
                  onChange={(value) => void assign(category, value)}
                />
                {assignment && levels.length ? (
                  <ModelThinkingOptions
                    advancedLabel={t`Advanced`}
                    thinkingLabel={t`Supports thinking`}
                    reasoning={assignment.thinkingLevel != null}
                    onReasoningChange={(enabled) =>
                      void assign(category, key, enabled ? (levels[0] ?? null) : null)
                    }
                    thinkingLevel={assignment.thinkingLevel}
                    onThinkingLevelChange={(value) =>
                      void assign(category, key, levels.find((level) => level === value) ?? null)
                    }
                    thinkingLevelOptions={levels.map((level) => ({
                      value: level,
                      label: thinkingLevelLabel(level),
                    }))}
                    thinkingLevelLabel={t`Reasoning effort`}
                    thinkingLevelDefaultLabel={t`Default`}
                  />
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
    </fieldset>
  );
}
