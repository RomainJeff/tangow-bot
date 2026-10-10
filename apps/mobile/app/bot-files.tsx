import { Stack, useLocalSearchParams } from "expo-router";
import { ScrollView } from "react-native";
import { FileList } from "../components/bot-page/files";
import { Group } from "../components/bot-page/kit";
import { useMobileTokens } from "../lib/native";

/** One folder of the bot's working files. */
export default function BotFilesScreen() {
  const { botId = "", path = "" } = useLocalSearchParams<{ botId: string; path: string }>();
  const tokens = useMobileTokens();
  const name = path.split("/").filter(Boolean).at(-1) ?? path;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 16, paddingTop: 24 }}
    >
      <Stack.Screen options={{ title: name }} />
      <Group>
        <FileList botId={botId} path={path} />
      </Group>
    </ScrollView>
  );
}
