import { useLocalSearchParams, useRouter } from "expo-router";
import { ScrollView } from "react-native";
import { Group, InkSwitch, Row, SaveMeta } from "../components/bot-page/kit";
import { useVoiceChoice } from "../lib/bot-choices";
import { type BotPageContext, useBotPageContext, useBotSetting } from "../lib/bot-page";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";

/** The voice the bot speaks with and how it replies; each control saves on change. */
export default function BotVoiceScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId: string }>();
  const page = useBotPageContext(botId);
  const tokens = useMobileTokens();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 16, paddingTop: 24 }}
    >
      {page ? <VoiceChoices page={page} /> : null}
    </ScrollView>
  );
}

function VoiceChoices({ page }: { page: BotPageContext }) {
  const { t } = useI18n();
  const router = useRouter();
  const voice = useVoiceChoice(page);
  const autoSpeak = useBotSetting(page, "autoSpeak");
  const chatty = useBotSetting(page, "chattyReplies");
  return (
    <Group>
      {voice && voice.load.kind !== "loading" ? (
        <Row
          label={voice.title}
          // A failed read of the voices cannot name the bot's voice; its list offers Retry.
          value={
            voice.load.kind === "ready" ? (voice.selected?.label ?? t("Account default")) : null
          }
          meta={<SaveMeta state={voice.save.state} onRetry={() => void voice.save.retry()} />}
          chevron
          disabled={voice.disabled}
          onPress={() =>
            router.push({ pathname: "/bot-choice", params: { botId: page.bot.id, kind: "voice" } })
          }
        />
      ) : null}
      <Row
        label={t("Read replies aloud")}
        meta={<SaveMeta state={autoSpeak.state} onRetry={autoSpeak.retry} />}
        control={
          <InkSwitch
            accessibilityLabel={t("Read replies aloud")}
            value={autoSpeak.value}
            disabled={page.readOnly}
            onValueChange={(value) => void autoSpeak.save(value)}
          />
        }
      />
      <Row
        label={t("Reply in several short messages")}
        meta={<SaveMeta state={chatty.state} onRetry={chatty.retry} />}
        control={
          <InkSwitch
            accessibilityLabel={t("Reply in several short messages")}
            value={chatty.value}
            disabled={page.readOnly}
            onValueChange={(value) => void chatty.save(value)}
          />
        }
      />
    </Group>
  );
}
