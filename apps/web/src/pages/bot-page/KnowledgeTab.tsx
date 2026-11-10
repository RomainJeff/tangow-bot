import { Trans, useLingui } from "@lingui/react/macro";
import type { MemoryDocument } from "@rakazo/contracts";
import { showsTeamMemory } from "@rakazo/core";
import { NativeSelect, NativeSelectOption, SaveMeta, SettingRow } from "@rakazo/ui-web";
import { type ReactNode, useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import {
  AgentFiles,
  AgentSkills,
  MemoryDocumentEditor,
  MemoryDocumentList,
} from "../KnowledgeSection";
import { ScratchpadSection } from "../ScratchpadSection";
import type { BotDetail } from "../shell/layout";
import { type BotPageContext, SettingsGroup, useBotField, useSaveLabels } from "./page-kit";

type MemoryScopeChoice = "" | "isolated" | "shared";

/** What the bot knows: its memory, the files on its computer, its skills, and open work. */
export function KnowledgeTab({
  page,
  memoryProviderConfigured,
  epoch,
  onOpen,
}: {
  page: BotPageContext;
  memoryProviderConfigured: boolean;
  /** Bumped when a wide editor closes, so the lists read again in place. */
  epoch: number;
  /** Memory documents and the skill editor open in the wide detail. */
  onOpen: (detail: BotDetail) => void;
}) {
  const { t } = useLingui();
  const { bot } = page;
  const showsTeam = useShowsTeamMemory(bot.id, epoch);
  return (
    <div data-testid="bot-knowledge" className="flex flex-col gap-6">
      <KnowledgeGroup label={t`Memory`}>
        <MemoryDocumentList
          key={bot.id}
          load={() => rpc.memory.list({ botId: bot.id, scope: "bot" })}
          epoch={epoch}
          exportFilename="memory.md"
          emptyLabel={<Trans>Nothing remembered yet</Trans>}
          testId="bot-knowledge-memory"
          onOpen={(doc) => onOpen({ kind: "memory", documentId: doc.id })}
        />
      </KnowledgeGroup>
      {showsTeam ? (
        <KnowledgeGroup label={t`Team memory`}>
          <MemoryDocumentList
            key={bot.id}
            load={() => rpc.memory.list({ botId: bot.id, scope: "team" })}
            epoch={epoch}
            exportFilename="team-memory.md"
            emptyLabel={<Trans>Nothing remembered yet</Trans>}
            testId="bot-knowledge-team-memory"
            onOpen={(doc) => onOpen({ kind: "memory", documentId: doc.id })}
          />
        </KnowledgeGroup>
      ) : null}
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
          epoch={epoch}
          onChanged={page.commands.skillsChanged}
          onOpenEditor={(skillId) => onOpen({ kind: "skill", skillId })}
        />
      </KnowledgeGroup>
      <ScratchpadSection botId={bot.id} />
    </div>
  );
}

function useShowsTeamMemory(botId: string, epoch: number): boolean {
  const [shows, setShows] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([rpc.bots.sharing({ botId }), rpc.memory.list({ botId, scope: "team" })])
      .then(([sharing, team]) => {
        if (!cancelled) setShows(showsTeamMemory(sharing, team));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId, epoch]);
  return shows;
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
      <div className="rounded-card bg-group p-1.5 shadow-group">{children}</div>
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

/** One memory document of the bot, read fresh, with its own Save and Cancel. */
export function MemoryDetail({
  botId,
  documentId,
  onDone,
}: {
  botId: string;
  documentId: string;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const [read, setRead] = useState<
    { kind: "loading" } | { kind: "failed" } | { kind: "ready"; doc: MemoryDocument | undefined }
  >({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    // The owner's memory of the bot, or its team memory.
    rpc.memory
      .list({ botId })
      .then((docs) => {
        if (!cancelled) setRead({ kind: "ready", doc: docs.find((doc) => doc.id === documentId) });
      })
      .catch(() => {
        if (!cancelled) setRead({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [botId, documentId]);
  // A document that is gone (removed by the bot) leaves the tab showing.
  const missing = read.kind === "ready" && !read.doc;
  useEffect(() => {
    if (missing) onDone();
  }, [missing, onDone]);

  if (read.kind === "failed") {
    return <p className="py-10 text-center text-meta text-muted-foreground">{t`Could not load`}</p>;
  }
  if (read.kind !== "ready" || !read.doc) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-2.5 text-title text-foreground" dir="auto">
        {read.doc.path}
      </h2>
      <MemoryDocumentEditor doc={read.doc} onSaved={onDone} onCancel={onDone} />
    </section>
  );
}
