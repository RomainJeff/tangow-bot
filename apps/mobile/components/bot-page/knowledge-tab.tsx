import type {
  AgentSkillCatalogEntry,
  BotSharing,
  MemoryDocument,
  SpaceMemoryConfig,
} from "@rakazo/contracts";
import { filterSkillList, showsTeamMemory } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useState } from "react";
import { rpc } from "../../lib/api";
import { useMemoryScopeChoice } from "../../lib/bot-choices";
import type { BotPageContext } from "../../lib/bot-page";
import { useBotField } from "../../lib/bot-page";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { FileList } from "./files";
import {
  Group,
  GroupAction,
  InkSwitch,
  LoadFailed,
  LoadingRows,
  QuietLine,
  Row,
  SaveMeta,
  Separated,
  useFocusedRead,
} from "./kit";
import { ScratchpadGroup } from "./scratchpad";

/** What the bot knows: its memory, the files on its computer, its skills, and open work. */
export function KnowledgeTab({
  page,
  epoch,
  onAddFocus,
}: {
  page: BotPageContext;
  epoch: number;
  onAddFocus: () => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <MemoryGroup page={page} epoch={epoch} />
      <TeamMemoryGroup botId={page.bot.id} epoch={epoch} />
      <Group label={t("Files")}>
        <FileList botId={page.bot.id} path="" shown={5} epoch={epoch} />
      </Group>
      <SkillsGroup page={page} />
      <ScratchpadGroup
        botId={page.bot.id}
        readOnly={page.readOnly}
        epoch={epoch}
        onAddFocus={onAddFocus}
      />
    </>
  );
}

/** `epoch` changes when a run ends: the bot may have written to its memory. */
function MemoryGroup({ page, epoch }: { page: BotPageContext; epoch: number }) {
  const { t } = useI18n();
  const router = useRouter();
  const botId = page.bot.id;
  const { read, retry } = useFocusedRead(
    () => rpc<MemoryDocument[]>("memory/list", { botId, scope: "bot" }),
    [botId, epoch],
  );
  // A bot has a memory scope only when its space has a memory provider.
  const provider = useFocusedRead(
    () => rpc<SpaceMemoryConfig | null>("memory/providerConfig"),
    [page.bot.spaceId],
  );
  const date = new Intl.DateTimeFormat(dateLocaleForUi(), { day: "numeric", month: "short" });
  return (
    <Group label={t("Memory")}>
      {read.kind === "loading" ? (
        <LoadingRows />
      ) : read.kind === "failed" ? (
        <LoadFailed onRetry={retry} />
      ) : read.value.length === 0 ? (
        <QuietLine>{t("Nothing remembered yet")}</QuietLine>
      ) : (
        read.value.map((doc) => (
          <Row
            key={doc.id}
            label={doc.path}
            subline={date.format(new Date(doc.updatedAt))}
            chevron
            onPress={() =>
              router.push({ pathname: "/bot-memory", params: { botId, documentId: doc.id } })
            }
          />
        ))
      )}
      {provider.read.kind === "ready" && provider.read.value ? (
        <MemoryScopeRow page={page} />
      ) : null}
    </Group>
  );
}

/**
 * What a run saved for everyone a shared bot is shared with, under the owner's own memory of it:
 * shown on a shared bot, and on any bot that still has some, since unsharing keeps it.
 */
function TeamMemoryGroup({ botId, epoch }: { botId: string; epoch: number }) {
  const { t } = useI18n();
  const router = useRouter();
  const { read } = useFocusedRead(
    () =>
      Promise.all([
        rpc<BotSharing>("bots/sharing", { botId }),
        rpc<MemoryDocument[]>("memory/list", { botId, scope: "team" }),
      ]).then(([sharing, docs]) => (showsTeamMemory(sharing, docs) ? docs : null)),
    [botId, epoch],
  );
  if (read.kind !== "ready" || read.value === null) return null;
  const date = new Intl.DateTimeFormat(dateLocaleForUi(), { day: "numeric", month: "short" });
  return (
    <Group label={t("Team memory")}>
      {read.value.length === 0 ? (
        <QuietLine>{t("Nothing remembered yet")}</QuietLine>
      ) : (
        read.value.map((doc) => (
          <Row
            key={doc.id}
            label={doc.path}
            subline={date.format(new Date(doc.updatedAt))}
            chevron
            onPress={() =>
              router.push({ pathname: "/bot-memory", params: { botId, documentId: doc.id } })
            }
          />
        ))
      )}
    </Group>
  );
}

function MemoryScopeRow({ page }: { page: BotPageContext }) {
  const router = useRouter();
  const choice = useMemoryScopeChoice(page);
  return (
    <Row
      label={choice.title}
      meta={<SaveMeta state={choice.save.state} onRetry={() => void choice.save.retry()} />}
      value={choice.selected?.label}
      chevron
      disabled={choice.disabled}
      onPress={() =>
        router.push({
          pathname: "/bot-choice",
          params: { botId: page.bot.id, kind: "memoryScope" },
        })
      }
    />
  );
}

const SKILLS_SHOWN = 5;

function SkillsGroup({ page }: { page: BotPageContext }) {
  const { t } = useI18n();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const botId = page.bot.id;
  const { read, write, retry } = useFocusedRead(
    () => rpc<AgentSkillCatalogEntry[]>("agentSkills/list"),
    [],
  );
  const beginReplace = () => {
    const settle = write();
    return (updated: AgentSkillCatalogEntry) =>
      settle((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              value: current.value.map((skill) => (skill.id === updated.id ? updated : skill)),
            }
          : current,
      );
  };

  const listed = read.kind === "ready" ? filterSkillList(read.value, { botId }) : [];
  // No search on iPhone: the skills a bot can switch lead, the always-on managed skills follow.
  const skills = [
    ...listed.filter((entry) => entry.source !== "builtin"),
    ...listed.filter((entry) => entry.source === "builtin"),
  ];
  const collapsible = skills.length > SKILLS_SHOWN;
  return (
    <Group
      label={t("Skills")}
      trailing={
        page.readOnly ? null : (
          <GroupAction
            label={t("Add")}
            accessibilityLabel={t("Add skill")}
            onPress={() => router.push("/skills")}
          />
        )
      }
    >
      {read.kind === "loading" ? (
        <LoadingRows />
      ) : read.kind === "failed" ? (
        <LoadFailed onRetry={retry} />
      ) : skills.length === 0 ? (
        <QuietLine>{t("No skills yet")}</QuietLine>
      ) : (
        <Separated>
          {(collapsible && !expanded ? skills.slice(0, SKILLS_SHOWN) : skills).map((entry) => (
            <SkillRow key={entry.id} page={page} entry={entry} beginReplace={beginReplace} />
          ))}
          {collapsible ? (
            <Row
              label={expanded ? t("Show less") : t("Show more")}
              onPress={() => setExpanded((value) => !value)}
            />
          ) : null}
        </Separated>
      )}
    </Group>
  );
}

/** A skill's switch for this bot, saved through the same store as every other setting. */
function SkillRow({
  page,
  entry,
  beginReplace,
}: {
  page: BotPageContext;
  entry: AgentSkillCatalogEntry;
  beginReplace: () => (entry: AgentSkillCatalogEntry) => void;
}) {
  const botId = page.bot.id;
  const access = useBotField(
    page,
    `skill:${entry.id}`,
    entry.visibleBotIds.includes(botId),
    async (enabled) => {
      const replace = beginReplace();
      replace(
        await rpc<AgentSkillCatalogEntry>("agentSkills/setAccess", {
          skillId: entry.id,
          bots: [{ botId, enabled }],
        }),
      );
    },
  );
  const router = useRouter();
  return (
    <Row
      label={entry.name}
      subline={entry.description}
      // A row with a switch carries no chevron, as in iOS Settings; tapping it still opens the skill.
      chevron={!page.readOnly && entry.source === "builtin"}
      onPress={
        page.readOnly
          ? undefined
          : () => router.push({ pathname: "/bot-skill", params: { skillId: entry.id } })
      }
      meta={<SaveMeta state={access.state} onRetry={access.retry} />}
      control={
        // Builtins are always on for every bot; only the rest carry a switch.
        entry.source !== "user" ? null : (
          <InkSwitch
            accessibilityLabel={entry.name}
            value={access.value}
            disabled={page.readOnly || access.state.kind === "saving"}
            onValueChange={(enabled) => void access.save(enabled)}
          />
        )
      }
    />
  );
}
