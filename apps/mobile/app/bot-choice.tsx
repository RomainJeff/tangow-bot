import { Stack, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { type ReactNode, useEffect } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Group, LoadFailed, LoadingRows, Row, SaveMeta } from "../components/bot-page/kit";
import { mobileTokens } from "../lib/appearance";
import {
  BOT_CHOICES,
  type BotChoice,
  type BotChoiceKind,
  isBotChoiceKind,
} from "../lib/bot-choices";
import { type BotPageContext, useBotPageContext } from "../lib/bot-page";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";

/**
 * One bot setting picked from a list, like iOS Settings: a tap saves the option and goes back.
 * A failed save stays here with its reason and Retry.
 */
export default function BotChoiceScreen() {
  const { botId = "", kind } = useLocalSearchParams<{ botId: string; kind: string }>();
  const page = useBotPageContext(botId);
  const known = botId && isBotChoiceKind(kind) ? kind : null;
  useLeaveWhen(known === null);
  if (!known) return null;
  return page ? (
    <ChoiceList key={known} page={page} kind={known} />
  ) : (
    <ChoiceFrame>
      <Group>
        <LoadingRows />
      </Group>
    </ChoiceFrame>
  );
}

/** A link this screen cannot show, or a choice that no longer applies, leaves instead of a blank. */
function useLeaveWhen(leave: boolean) {
  const router = useRouter();
  useEffect(() => {
    if (!leave) return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [leave, router]);
}

function ChoiceFrame({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createChoiceStyles);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {children}
    </ScrollView>
  );
}

function ChoiceList({ page, kind }: { page: BotPageContext; kind: BotChoiceKind }) {
  const useChoice = BOT_CHOICES[kind];
  const choice = useChoice(page);
  useLeaveWhen(choice === null);
  if (!choice) return null;
  return (
    <ChoiceFrame>
      <Stack.Screen options={{ title: choice.title }} />
      <ChoiceBody choice={choice} />
    </ChoiceFrame>
  );
}

function ChoiceBody({ choice }: { choice: BotChoice }) {
  const styles = useThemedStyles(createChoiceStyles);
  const { t } = useI18n();
  const router = useRouter();
  const navigation = useNavigation();
  const { load } = choice;
  if (load.kind === "loading") {
    return (
      <Group>
        <LoadingRows />
      </Group>
    );
  }
  if (load.kind === "failed" && !load.reason) {
    return (
      <Group>
        <LoadFailed onRetry={load.retry} />
      </Group>
    );
  }

  const choose = async (id: string) => {
    // A save answering after the person went back must not pop the screen under this one.
    if ((await choice.choose(id)) && navigation.isFocused()) router.back();
  };

  return (
    <>
      <Group>
        {choice.options.map((option) => (
          <Row
            key={option.id}
            label={option.label}
            checked={option.id === choice.selected?.id}
            disabled={choice.disabled}
            onPress={() => void choose(option.id)}
          />
        ))}
      </Group>
      <View style={styles.footer}>
        {choice.note ? <Text style={styles.note}>{choice.note}</Text> : null}
        {load.kind === "failed" ? (
          <Pressable accessibilityRole="button" hitSlop={8} onPress={load.retry}>
            <Text style={[styles.note, styles.failed]}>{`${load.reason} · ${t("Retry")}`}</Text>
          </Pressable>
        ) : null}
        <SaveMeta state={choice.save.state} onRetry={() => void choice.save.retry()} />
      </View>
    </>
  );
}

function createChoiceStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: tokens.background },
    content: { padding: 16, paddingTop: 24, gap: 8 },
    footer: { paddingHorizontal: 16, gap: 4 },
    note: { color: tokens.mutedForeground, ...nativeTextStyle("meta", { size: 14 }) },
    failed: { color: tokens.destructive },
  });
}
