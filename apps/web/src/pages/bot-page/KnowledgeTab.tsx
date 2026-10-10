import { Trans, useLingui } from "@lingui/react/macro";
import { NativeSelect, NativeSelectOption, SaveMeta, SettingRow, Surface } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { rpc } from "../../lib/rpc";
import { AgentFiles, AgentSkills, MemoryDocumentList } from "../KnowledgeSection";
import { ScratchpadSection } from "../ScratchpadSection";
import type { BotDetail } from "../shell/layout";
import { type BotPageContext, SettingsGroup, useBotField, useSaveLabels } from "./page-kit";

type MemoryScopeChoice = "" | "isolated" | "shared";

/** What the bot knows: its memory, the files on its computer, its skills, and open work. */
export function KnowledgeTab({
  page,
  memoryProviderConfigured,
  onOpen,
}: {
  page: BotPageContext;
  memoryProviderConfigured: boolean;
  /** The skill editor opens in the wide detail. */
  onOpen: (detail: BotDetail) => void;
}) {
  const { t } = useLingui();
  const { bot } = page;
  return (
    <div data-testid="bot-knowledge" className="flex flex-col gap-6">
      <KnowledgeGroup label={t`Memory`}>
        <MemoryDocumentList
          key={bot.id}
          load={() => rpc.memory.list({ botId: bot.id, scope: "bot" })}
          exportFilename="memory.md"
          emptyLabel={<Trans>Nothing remembered yet</Trans>}
          testId="bot-knowledge-memory"
        />
      </KnowledgeGroup>
      {memoryProviderConfigured ? (
        <SettingsGroup>
          <MemoryScopeRow page={page} />
        </SettingsGroup>
      ) : null}
      <KnowledgeGroup label={t`Files`}>
        <AgentFiles key={bot.id} botId={bot.id} />
      </KnowledgeGroup>
      <KnowledgeGroup label={t`Skills`} testId="bot-skills">
        <AgentSkills
          botId={bot.id}
          onOpenEditor={(skillId) => onOpen({ kind: "skill", skillId })}
          onChanged={page.commands.skillsChanged}
        />
      </KnowledgeGroup>
      <ScratchpadSection botId={bot.id} />
    </div>
  );
}

function KnowledgeGroup({
  label,
  testId,
  children,
}: {
  label: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5" data-testid={testId}>
      <h2 className="mx-3.5 text-label text-muted-foreground">{label}</h2>
      <Surface className="bg-background p-1.5">{children}</Surface>
    </section>
  );
}

function MemoryScopeRow({ page }: { page: BotPageContext }) {
  const { t } = useLingui();
  const labels = useSaveLabels();
  const scope = useBotField<MemoryScopeChoice>(
    page,
    "memoryScope",
    page.bot.memoryScope ?? "",
    (value) => ({ memoryScope: value || null }),
  );
  return (
    <SettingRow
      label={t`Memory scope`}
      meta={<SaveMeta state={scope.state} labels={labels} onRetry={scope.retry} />}
    >
      <NativeSelect
        aria-label={t`Memory scope`}
        size="sm"
        value={scope.value}
        onChange={(event) => void scope.save(event.target.value as MemoryScopeChoice)}
      >
        <NativeSelectOption value="">{t`Inherit default`}</NativeSelectOption>
        <NativeSelectOption value="isolated">{t`Isolated`}</NativeSelectOption>
        <NativeSelectOption value="shared">{t`Shared`}</NativeSelectOption>
      </NativeSelect>
    </SettingRow>
  );
}
