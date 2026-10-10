import type { AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";
import { filterSkillList } from "@rakazo/core";
import { useRouter } from "expo-router";
import { useState } from "react";
import { rpc } from "../../lib/api";
import { type BotPageContext, useBotField } from "../../lib/bot-page";
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

/** What the bot knows: its memory, the files on its computer, and its skills. */
export function KnowledgeTab({ page, epoch }: { page: BotPageContext; epoch: number }) {
  const { t } = useI18n();
  return (
    <>
      <MemoryGroup page={page} epoch={epoch} />
      <Group label={t("Files")}>
        <FileList botId={page.bot.id} path="" shown={5} epoch={epoch} />
      </Group>
      <SkillsGroup page={page} />
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
    </Group>
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
  // No search on iPhone: the skills a bot can switch lead, the always-on builtins follow.
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
        entry.source === "builtin" ? null : (
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
