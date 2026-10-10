import { Alert } from "react-native";
import { rpc } from "./api";
import { t } from "./i18n";

export function confirmDeleteBot(bot: { id: string; name: string }, onDeleted: () => void) {
  const remove = async (deleteMemories: boolean) => {
    try {
      await rpc("bots/remove", { botId: bot.id, deleteMemories });
      onDeleted();
    } catch (error) {
      Alert.alert(
        t("Could not delete bot"),
        error instanceof Error ? error.message : t("Try again."),
      );
    }
  };

  Alert.alert(
    t("Delete {name}?", { name: bot.name }),
    t(
      "Its conversation, files, and routines will be permanently deleted. What should happen to its memories?",
    ),
    [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Keep memories"), onPress: () => void remove(false) },
      {
        text: t("Delete memories too"),
        style: "destructive",
        onPress: () => void remove(true),
      },
    ],
  );
}

/** Asks before clearing a conversation: it removes every message and stops current work. */
export function confirmClearConversation(clear: () => void) {
  Alert.alert(
    t("Clear conversation?"),
    t(
      "This removes every message and stops current work. The bot, computer, memory, and routines are kept.",
    ),
    [
      { text: t("Cancel"), style: "cancel" },
      { text: t("Clear"), style: "destructive", onPress: clear },
    ],
  );
}

export function archiveBot(botId: string, onArchived: () => void) {
  void rpc("bots/archive", { botId })
    .then(onArchived)
    .catch((error) =>
      Alert.alert(
        t("Could not archive bot"),
        error instanceof Error ? error.message : t("Try again."),
      ),
    );
}
