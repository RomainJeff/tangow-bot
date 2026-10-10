import type { AgentSkillCatalogEntry, MemoryDocument } from "@rakazo/contracts";
import { filterSkillList } from "@rakazo/core";
import { useRouter } from "expo-router";
import { View } from "react-native";
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
  useFocusedRead,
} from "./kit";

/** What the bot knows: its memory, the files on its computer, and its skills. */
export function KnowledgeTab({ page, epoch }: { page: BotPageContext; epoch: number }) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 28 }}>
      <MemoryGroup page={page} epoch={epoch} />
      <Group label={t("Files")}>
        <FileList botId={page.bot.id} path="" shown={5} epoch={epoch} />
      </Group>
      <SkillsGroup page={page} />
    </View>
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

function SkillsGroup({ page }: { page: BotPageContext }) {
  const { t } = useI18n();
  const router = useRouter();
  const botId = page.bot.id;
  const { read, settle, retry } = useFocusedRead(
    () => rpc<AgentSkillCatalogEntry[]>("agentSkills/list"),
    [],
  );
  const replace = (updated: AgentSkillCatalogEntry) =>
    settle((current) =>
      current.kind === "ready"
        ? {
            kind: "ready",
            value: current.value.map((skill) => (skill.id === updated.id ? updated : skill)),
          }
        : current,
    );

  const skills = read.kind === "ready" ? filterSkillList(read.value, { botId }) : [];
  return (
    <Group
      label={t("Skills")}
      trailing={
        page.readOnly ? null : (
          <GroupAction label={t("Add")} onPress={() => router.push("/skills")} />
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
        skills.map((entry) => (
          <SkillRow key={entry.id} page={page} entry={entry} onSaved={replace} />
        ))
      )}
    </Group>
  );
}

/** A skill's switch for this bot, saved through the same store as every other setting. */
function SkillRow({
  page,
  entry,
  onSaved,
}: {
  page: BotPageContext;
  entry: AgentSkillCatalogEntry;
  onSaved: (entry: AgentSkillCatalogEntry) => void;
}) {
  const botId = page.bot.id;
  const access = useBotField(
    page,
    `skill:${entry.id}`,
    entry.visibleBotIds.includes(botId),
    async (enabled) => {
      onSaved(
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
      chevron={!page.readOnly}
      onPress={
        page.readOnly
          ? undefined
          : () => router.push({ pathname: "/bot-skill", params: { botId, skillId: entry.id } })
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
