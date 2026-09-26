import type {
  MemoryCollectionKind,
  MemoryLibraryDocument,
  MemoryLibrarySummary,
  MemoryStatus,
  SpaceNavigation,
} from "@rakazo/contracts";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ApiRequestContext } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useMemoryWorkspace } from "../lib/use-memory-workspace";

export default function MemoryScreen() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const { workspace, error } = useMemoryWorkspace(spaceId);
  const { t } = useI18n();
  const tokens = useMobileTokens();
  if (!workspace)
    return (
      <View style={[styles.screen, { backgroundColor: tokens.background }]}>
        <Stack.Screen options={{ title: t("Memory") }} />
        {error ? (
          <Text style={{ color: tokens.destructive }}>{t("Could not load workspace")}</Text>
        ) : null}
      </View>
    );
  return (
    <MemoryLibrary
      key={workspace.navigation.current.id}
      workspace={workspace.navigation}
      requestContext={workspace.requestContext}
    />
  );
}

function MemoryLibrary({
  workspace,
  requestContext,
}: {
  workspace: SpaceNavigation;
  requestContext: ApiRequestContext;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const {
    botId,
    messageId,
    collection: collectionParam,
  } = useLocalSearchParams<{
    botId?: string;
    messageId?: string;
    collection?: MemoryCollectionKind;
  }>();
  const [collection, setCollection] = useState<MemoryCollectionKind>(
    collectionParam ?? (botId ? "agent" : "space"),
  );
  const [status, setStatus] = useState<MemoryStatus>("active");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MemoryLibrarySummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState({ active: 0, proposed: 0, withdrawn: 0 });
  const bots = workspace.current.bots.filter((bot) => !bot.archivedAt);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const selectedBotId = collection === "agent" ? botId : undefined;
  async function refresh(cursor?: string) {
    const current = ++request.current;
    if (!cursor) {
      setItems([]);
      setNextCursor(null);
    }
    try {
      const result = await rpc<{
        items: MemoryLibrarySummary[];
        nextCursor: string | null;
        facets: { active: number; proposed: number; withdrawn: number };
      }>(
        "memory/library/list",
        {
          collection,
          ...(selectedBotId ? { botId: selectedBotId } : {}),
          status,
          ...(query ? { query } : {}),
          limit: 30,
          ...(cursor ? { cursor } : {}),
        },
        { requestContext },
      );
      if (current !== request.current) return;
      setItems((items) => (cursor ? [...items, ...result.items] : result.items));
      setNextCursor(result.nextCursor);
      setFacets(result.facets);
      setError(null);
    } catch {
      if (current === request.current) setError(t("Could not load memories"));
    }
  }
  useFocusEffect(
    useCallback(() => {
      void refresh();
      return () => {
        request.current += 1;
      };
    }, [collection, status, query, selectedBotId]),
  );
  useEffect(() => {
    if (!messageId) return;
    let active = true;
    void rpc<MemoryLibraryDocument>(
      "memory/library/capture",
      {
        messageId,
        ...(botId ? { botId } : {}),
        idempotencyKey: `capture:${botId ?? "space"}:${messageId}`,
      },
      { requestContext },
    )
      .then((document) => {
        if (active)
          router.replace({
            pathname: "/memory-detail",
            params: { documentId: document.id, spaceId: workspace.current.id },
          });
      })
      .catch(() => {
        if (active) setError(t("Could not remember message"));
      });
    return () => {
      active = false;
    };
  }, [messageId, botId, router, requestContext, workspace.current.id]);
  return (
    <View style={[styles.screen, { backgroundColor: tokens.background }]}>
      <Stack.Screen
        options={{
          title: t("Memory"),
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Workspace")}
        accessibilityValue={{ text: workspace.current.name }}
        onPress={() =>
          presentMessageActionSheet({
            title: t("Workspace"),
            actions: workspace.spaces.map((space) => ({
              text: space.name,
              onPress: () =>
                router.setParams({ spaceId: space.id, botId: "", messageId: "", collection }),
            })),
            cancel: t("Cancel"),
            more: t("More"),
            colorScheme,
          })
        }
        style={styles.workspace}
      >
        <Text style={{ color: tokens.foreground }}>{workspace.current.name} ▾</Text>
      </Pressable>
      <View style={styles.row}>
        {(["space", "personal", "agent"] as const).map((kind) => (
          <Chip
            key={kind}
            label={
              kind === "space" ? t("Shared") : kind === "personal" ? t("Personal") : t("Agent")
            }
            active={collection === kind}
            onPress={() => setCollection(kind)}
          />
        ))}
      </View>
      {collection === "agent" ? (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            presentMessageActionSheet({
              title: t("Agent"),
              actions: [
                { text: t("All agents"), onPress: () => router.setParams({ botId: "" }) },
                ...bots.map((bot) => ({
                  text: bot.name,
                  onPress: () => router.setParams({ botId: bot.id }),
                })),
              ],
              cancel: t("Cancel"),
              more: t("More"),
              colorScheme,
            })
          }
          style={styles.chip}
        >
          <Text style={{ color: tokens.foreground }}>
            {bots.find((bot) => bot.id === botId)?.name ?? t("All agents")}
          </Text>
        </Pressable>
      ) : null}
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={t("Search")}
        placeholderTextColor={tokens.mutedForeground}
        style={[styles.search, { color: tokens.foreground, borderColor: tokens.input }]}
      />
      <View style={styles.row}>
        {(["active", "proposed", "withdrawn"] as const)
          .filter((value) => value !== "proposed" || facets.proposed > 0 || status === "proposed")
          .map((value) => (
            <Chip
              key={value}
              label={
                value === "active"
                  ? t("Active")
                  : value === "proposed"
                    ? t("Proposals")
                    : t("Withdrawn")
              }
              active={status === value}
              onPress={() => setStatus(value)}
            />
          ))}
      </View>
      {error ? <Text style={{ color: tokens.destructive }}>{error}</Text> : null}
      <ScrollView contentContainerStyle={styles.list}>
        {items.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: "/memory-detail",
                params: { documentId: item.id, spaceId: workspace.current.id },
              })
            }
            style={[styles.item, { borderBottomColor: tokens.border }]}
          >
            <Text numberOfLines={1} style={{ color: tokens.foreground }}>
              {item.title || t("Untitled memory")}
            </Text>
            {collection === "agent" && !botId ? (
              <Text style={{ color: tokens.mutedForeground }}>
                {bots.find((bot) => bot.id === item.collection.botId)?.name ?? t("Agent")}
              </Text>
            ) : null}
            {item.qualification.impact === "important" ? (
              <Text style={{ color: tokens.warning }}>{t("Important")}</Text>
            ) : null}
          </Pressable>
        ))}
        {!items.length ? (
          <Text style={{ color: tokens.mutedForeground }}>{t("Nothing remembered yet")}</Text>
        ) : null}
        {nextCursor ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void refresh(nextCursor)}
            style={styles.chip}
          >
            <Text style={{ color: tokens.foreground }}>{t("Load more")}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const tokens = useMobileTokens();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.chip, { backgroundColor: active ? tokens.muted : "transparent" }]}
    >
      <Text style={{ color: tokens.foreground }}>{label}</Text>
    </Pressable>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, padding: 16 },
  workspace: { minHeight: 44, justifyContent: "center", marginBottom: 12 },
  row: { flexDirection: "row", gap: 8, marginBottom: 12, alignItems: "center" },
  chip: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 999 },
  search: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
  },
  add: {
    marginLeft: "auto",
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { paddingBottom: 32 },
  item: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
});
