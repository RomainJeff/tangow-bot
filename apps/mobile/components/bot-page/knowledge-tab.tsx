import type { MemoryDocument } from "@rakazo/contracts";
import { useRouter } from "expo-router";
import { View } from "react-native";
import { rpc } from "../../lib/api";
import type { BotPageContext } from "../../lib/bot-page";
import { dateLocaleForUi, useI18n } from "../../lib/i18n";
import { FileList } from "./files";
import { Group, LoadFailed, LoadingRows, QuietLine, Row, useFocusedRead } from "./kit";

/** What the bot knows: its memory and the files on its computer. */
export function KnowledgeTab({ page, epoch }: { page: BotPageContext; epoch: number }) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 28 }}>
      <MemoryGroup page={page} epoch={epoch} />
      <Group label={t("Files")}>
        <FileList botId={page.bot.id} path="" shown={5} epoch={epoch} />
      </Group>
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
