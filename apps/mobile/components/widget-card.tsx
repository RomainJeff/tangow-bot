import type { MessageBlock } from "@rakazo/contracts";
import { buildWidgetDocument, parseWidgetHeightMessage } from "@rakazo/core/widget";
import { radii, sizes } from "@rakazo/ui-tokens";
import { useEffect, useRef, useState } from "react";
import { Linking, Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import type { WebViewMessageEvent } from "react-native-webview";
import WebView from "react-native-webview";
import { mobileTokens } from "../lib/appearance";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { readMobileArtifactText } from "../lib/artifact-open";
import { useI18n } from "../lib/i18n";
import { useResolvedAppearance } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";
import { Surface } from "./surface";

function openWidgetLink(url: string) {
  if (url.startsWith("https:")) void Linking.openURL(url).catch(() => undefined);
}

function WidgetWebView({ html, fullscreen = false }: { html: string; fullscreen?: boolean }) {
  const theme = useResolvedAppearance();
  const [height, setHeight] = useState(192);
  const frame = useRef<WebView>(null);
  const [source] = useState(() => ({ html: buildWidgetDocument({ html, theme }) }));
  const themeScript = `window.postMessage(${JSON.stringify({ rakazoWidgetTheme: theme })}, "*"); true;`;
  useEffect(() => {
    frame.current?.injectJavaScript(themeScript);
  }, [themeScript]);
  return (
    <WebView
      ref={frame}
      onLoadEnd={() => frame.current?.injectJavaScript(themeScript)}
      source={source}
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={(request) => {
        if (request.url.startsWith("about:")) return true;
        if (request.navigationType === "click") openWidgetLink(request.url);
        return false;
      }}
      onOpenWindow={({ nativeEvent }) => openWidgetLink(nativeEvent.targetUrl)}
      scrollEnabled={fullscreen}
      allowsInlineMediaPlayback
      allowsFullscreenVideo
      onMessage={(event: WebViewMessageEvent) => {
        if (fullscreen) return;
        const measured = parseWidgetHeightMessage(event.nativeEvent.data);
        if (measured !== null) setHeight(Math.min(measured, 20_000));
      }}
      style={[styles.webview, fullscreen ? styles.fullscreen : { height, flex: 0 }]}
    />
  );
}

export function WidgetCard({
  block,
  artifactTarget,
}: {
  block: Extract<MessageBlock, { kind: "widget" }>;
  artifactTarget: MobileArtifactTarget;
}) {
  const { t } = useI18n();
  const tokens = mobileTokens();
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; html: string } | { status: "error" }
  >({ status: "loading" });
  const botId = "botId" in artifactTarget ? artifactTarget.botId : undefined;
  const groupId = "groupId" in artifactTarget ? artifactTarget.groupId : undefined;
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const target: MobileArtifactTarget = botId !== undefined ? { botId } : { groupId: groupId! };
    void readMobileArtifactText(target, block.artifactId, "text/html").then(
      (html) => {
        if (!cancelled) setState({ status: "ready", html });
      },
      () => {
        if (!cancelled) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [botId, groupId, block.artifactId]);
  if (state.status === "loading") return <Surface style={styles.loading} />;
  if (state.status === "error") {
    return (
      <Surface style={styles.error}>
        <Text style={{ color: tokens.destructive, ...nativeTextStyle("meta") }}>
          {t("Could not load this file.")}
        </Text>
      </Surface>
    );
  }
  return (
    <>
      <Surface style={styles.card}>
        <WidgetWebView key={block.artifactId} html={state.html} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Open in full screen")}
          onPress={() => setExpanded(true)}
          style={[styles.expand, { backgroundColor: tokens.secondary }]}
        >
          <NativeSymbol
            ios="arrow.up.left.and.arrow.down.right"
            android="expand-outline"
            size={18}
            color={tokens.secondaryForeground}
          />
        </Pressable>
      </Surface>
      <Modal
        visible={expanded}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setExpanded(false)}
      >
        <SafeAreaView style={[styles.fullscreen, { backgroundColor: tokens.background }]}>
          <View style={styles.header}>
            <Text
              numberOfLines={1}
              style={{ flex: 1, color: tokens.foreground, ...nativeTextStyle("title") }}
            >
              {block.title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Close preview")}
              onPress={() => setExpanded(false)}
              style={styles.close}
            >
              <NativeSymbol ios="xmark" android="close" size={19} color={tokens.foreground} />
            </Pressable>
          </View>
          {expanded ? <WidgetWebView key={block.artifactId} html={state.html} fullscreen /> : null}
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  webview: { backgroundColor: "transparent" },
  fullscreen: { flex: 1 },
  loading: { height: 192, width: "100%" },
  error: { padding: 16 },
  card: { width: "100%", overflow: "hidden" },
  expand: {
    position: "absolute",
    top: 8,
    right: 8,
    borderRadius: radii.pill,
    padding: 12,
    minWidth: sizes.composerTarget,
    minHeight: sizes.composerTarget,
    alignItems: "center",
    justifyContent: "center",
  },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12 },
  close: { padding: 12 },
});
