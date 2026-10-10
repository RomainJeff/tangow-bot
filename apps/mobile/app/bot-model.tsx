import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView } from "react-native";
import { Group, Row, SaveMeta } from "../components/bot-page/kit";
import {
  type BotChoiceKind,
  modelChoice,
  thinkingChoice,
  useModelFields,
} from "../lib/bot-choices";
import { type BotPageContext, useBotPageContext } from "../lib/bot-page";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** The model the bot runs and how hard it thinks; each opens its list, which saves when picked. */
export default function BotModelScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const page = useBotPageContext(botId);
  const tokens = useMobileTokens();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 16, paddingTop: 24 }}
    >
      {page ? <ModelChoices page={page} /> : null}
    </ScrollView>
  );
}

function ModelChoices({ page }: { page: BotPageContext }) {
  const { t } = useI18n();
  const router = useRouter();
  const fields = useModelFields(page);
  const model = modelChoice(page, fields);
  const thinking = thinkingChoice(page, fields);
  const open = (kind: BotChoiceKind) =>
    router.push({ pathname: "/bot-choice", params: { botId: page.bot.id, kind } });
  return (
    <Group>
      <Row
        label={model.title}
        subline={fields.load.kind === "failed" ? t("Could not load model settings") : null}
        value={model.selected?.label}
        meta={<SaveMeta state={model.save.state} onRetry={() => void model.save.retry()} />}
        chevron
        disabled={model.disabled}
        onPress={() => open("model")}
      />
      {thinking?.load.kind === "ready" ? (
        <Row
          label={thinking.title}
          value={thinking.selected?.label}
          meta={<SaveMeta state={thinking.save.state} onRetry={() => void thinking.save.retry()} />}
          chevron
          disabled={thinking.disabled}
          onPress={() => open("thinking")}
        />
      ) : null}
    </Group>
  );
}
