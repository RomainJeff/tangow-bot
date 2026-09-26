import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type {
  MemoryLibraryDocument,
  MemoryLibraryRevision,
  MemoryMethodAnnotation,
} from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { rpc, selectSpace } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useResolvedAppearance } from "../lib/native";
import { useMemoryWorkspace } from "../lib/use-memory-workspace";

export default function MemoryDetailScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const router = useRouter();
  const { documentId, spaceId } = useLocalSearchParams<{ documentId: string; spaceId?: string }>();
  const { workspace, error: workspaceError } = useMemoryWorkspace(spaceId);
  const [document, setDocument] = useState<MemoryLibraryDocument | null>(null);
  const [annotations, setAnnotations] = useState<MemoryMethodAnnotation[]>([]);
  const [history, setHistory] = useState<MemoryLibraryRevision[] | null>(null);
  const [details, setDetails] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setDocument(null);
    if (documentId && workspace)
      void Promise.all([
        rpc<MemoryLibraryDocument>(
          "memory/library/get",
          { documentId },
          { requestContext: workspace.requestContext },
        ),
        rpc<MemoryMethodAnnotation[]>(
          "memory/library/annotations",
          { documentId },
          { requestContext: workspace.requestContext },
        ),
      ])
        .then(([doc, items]) => {
          if (active) {
            setDocument(doc);
            setAnnotations(items);
          }
        })
        .catch(() => {
          if (active) setError(t("Could not load memory"));
        });
    return () => {
      active = false;
    };
  }, [documentId, t, workspace]);
  const current = annotations.filter(
    (item, index) => annotations.findIndex((other) => other.bot.id === item.bot.id) === index,
  );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.background }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      <Stack.Screen options={{ title: document?.title || t("Memory") }} />
      {workspaceError ? (
        <Text style={{ color: tokens.destructive }}>{t("Could not load workspace")}</Text>
      ) : null}
      {error ? <Text style={{ color: tokens.destructive }}>{error}</Text> : null}
      {document ? (
        <>
          <Text style={{ color: tokens.mutedForeground }}>
            {workspace?.navigation.current.name} ·{" "}
            {document.collection.kind === "space"
              ? t("Shared")
              : document.collection.kind === "agent"
                ? t("Agent")
                : t("Personal")}
            {document.collection.botId
              ? ` · ${workspace?.navigation.current.bots.find((bot) => bot.id === document.collection.botId)?.name ?? t("Agent")}`
              : ""}
          </Text>
          <ChatMarkdown allowImages={false} palette={tokens} colorScheme={colorScheme}>
            {document.content}
          </ChatMarkdown>
          {current.map((item) => (
            <View key={item.id} style={{ gap: 8 }}>
              <Pressable
                accessibilityRole="button"
                onPress={async () => {
                  if (!workspace || !(await selectSpace(workspace.navigation.current.id))) {
                    setError(t("Could not load workspace"));
                    return;
                  }
                  router.push({ pathname: "/thread", params: { botId: item.bot.id } });
                }}
              >
                <Text style={{ color: tokens.foreground }}>{item.bot.name}</Text>
              </Pressable>
              {item.method.questions.map((question) => (
                <Text key={question.key} style={{ color: tokens.mutedForeground }}>
                  {question.label}:{" "}
                  {question.options.find((option) => option.key === item.answers[question.key])
                    ?.label ?? t("None")}
                </Text>
              ))}
            </View>
          ))}
          <Pressable accessibilityRole="button" onPress={() => setDetails((value) => !value)}>
            <Text style={{ color: tokens.mutedForeground }}>{t("Details")}</Text>
          </Pressable>
          {details ? (
            <View style={{ gap: 12 }}>
              {document.qualification.documentType ? (
                <Text style={{ color: tokens.mutedForeground }}>
                  {document.qualification.documentType}
                </Text>
              ) : null}
              {(document.evidence?.length ? document.evidence : document.sources).map(
                (source, index) =>
                  source.excerpt ? (
                    <Text key={index} style={{ color: tokens.mutedForeground }}>
                      {source.excerpt}
                    </Text>
                  ) : null,
              )}
              <Pressable
                accessibilityRole="button"
                onPress={() =>
                  void rpc<MemoryLibraryRevision[]>(
                    "memory/library/history",
                    { documentId },
                    { requestContext: workspace?.requestContext },
                  )
                    .then(setHistory)
                    .catch(() => setError(t("Could not load history")))
                }
              >
                <Text style={{ color: tokens.foreground }}>{t("History")}</Text>
              </Pressable>
              {history?.map((revision) => (
                <View key={revision.id}>
                  <Text style={{ color: tokens.mutedForeground }}>rev {revision.revision}</Text>
                  <ChatMarkdown allowImages={false} palette={tokens} colorScheme={colorScheme}>
                    {revision.content}
                  </ChatMarkdown>
                </View>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}
