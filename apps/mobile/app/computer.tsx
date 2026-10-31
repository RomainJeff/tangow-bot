import type { ComputerMode, ComputerReleaseReason } from "@rakazo/contracts";
import { useLocalSearchParams, useNavigation } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
} from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { ComputerModePicker } from "../components/computer-mode-picker";
import { NativeSymbol } from "../components/native-symbol";
import { ScreenLinkOverlay } from "../components/screen-link-overlay";
import { currentAccessHeaders } from "../lib/access-store";
import { currentApiBase, rpc } from "../lib/api";
import {
  COMPUTER_HEARTBEAT_MS,
  type ComputerStatus,
  computerLabel,
  controlLabel,
  embeddableScreenUrl,
  previewPlaceholder,
  readScreenUrl,
  SCREEN_URL_OPEN_ATTEMPTS,
} from "../lib/computer";
import { createComputerRefresh } from "../lib/computer-refresh";
import { defaultApiBase } from "../lib/endpoint";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { screenLinkEffects } from "../lib/screen-link";
import { useScreenLink } from "../lib/use-screen-link";

export default function Computer() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const navigation = useNavigation();
  const { botId, name: nameParam } = useLocalSearchParams<{ botId?: string; name?: string }>();
  const name = nameParam || t("Bot");
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readyBotId, setReadyBotId] = useState<string | null>(null);
  const [bootingCount, setBootingCount] = useState(0);
  const [switchingCount, setSwitchingCount] = useState(0);
  const booting = bootingCount > 0;
  const switching = switchingCount > 0;
  const [computerOpen, setComputerOpen] = useState(false);
  const autoBooted = useRef<string | null>(null);

  const embeddedScreenUrl = embeddableScreenUrl(screenUrl, currentApiBase());
  useEffect(() => setScreenError(null), [embeddedScreenUrl]);

  const hasControl = computer?.controlHolder === "user" && computer.controlBotId === botId;
  const label = computerLabel(computer?.mode, name);

  useLayoutEffect(() => {
    navigation.setOptions({ title: label });
  }, [label, navigation]);

  const refreshController = useMemo(
    () =>
      createComputerRefresh({
        readStatus: () => rpc<ComputerStatus>("computer/status", { botId }),
        readScreen: (attempts) =>
          readScreenUrl(() => rpc<{ url: string | null }>("computer/screenUrl", { botId }), {
            attempts,
          }),
        onStatus: setComputer,
        onScreen: setScreenUrl,
        onReady: () => setReadyBotId(botId ?? null),
        onInitialError: (err) => setError(err instanceof Error ? err.message : String(err)),
      }),
    [botId],
  );
  const screenEffects = useMemo(
    () => screenLinkEffects(refreshController.refresh),
    [refreshController],
  );
  const onScreenError = () => {
    refreshController.invalidateScreen();
    setScreenError(t("Could not load the desktop. This device cannot reach the screen URL."));
  };

  useEffect(() => {
    setComputer(null);
    setScreenUrl(null);
    setScreenError(null);
    setError(null);
    setReadyBotId(null);
    setBootingCount(0);
    setSwitchingCount(0);
    setComputerOpen(false);
    autoBooted.current = null;
    if (botId) refreshController.start();
    return () => refreshController.dispose();
  }, [botId, refreshController]);

  async function bootComputer({
    takeControl,
    overlay,
    force = false,
    forceScreen = true,
  }: {
    takeControl: boolean;
    overlay: boolean;
    force?: boolean;
    forceScreen?: boolean;
  }) {
    if (!botId || !refreshController.isActive()) return false;
    const action = refreshController.beginAction();
    const needsBoot = force || computer?.state !== "running" || !screenUrl;
    const showBooting = overlay && needsBoot;
    if (showBooting) setBootingCount((count) => count + 1);
    try {
      if (needsBoot) await rpc("computer/boot", { botId });
      if (!action.isActive()) return false;
      if (takeControl) await rpc("computer/takeover", { botId });
      if (!action.isActive()) return false;
      await action.refresh({
        screenAttempts: SCREEN_URL_OPEN_ATTEMPTS,
        force: forceScreen || !screenUrl,
      });
      if (!action.isActive()) return false;
      setError(null);
      return true;
    } catch (err) {
      if (!action.isActive()) return false;
      setError(err instanceof Error ? err.message : t("Could not open computer"));
      throw err;
    } finally {
      if (action.isActive() && showBooting) setBootingCount((count) => count - 1);
      action.finish();
    }
  }

  useEffect(() => {
    if (!botId || readyBotId !== botId || switching) return;
    if (computer?.state === "booting" || computer?.state === "suspended") return;
    if (autoBooted.current === botId) return;
    autoBooted.current = botId;
    void bootComputer({
      takeControl: false,
      overlay: computer?.state !== "running",
      force: true,
      forceScreen: computer?.state !== "running",
    }).catch(() => undefined);
  }, [readyBotId, botId, computer?.state, switching]);

  useEffect(() => {
    if (!botId || computer?.state !== "running") return;
    const ping = () => void rpc("computer/heartbeat", { botId }).catch(() => undefined);
    ping();
    const timer = setInterval(ping, COMPUTER_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [botId, computer?.state]);

  async function openComputer({ takeControl = false }: { takeControl?: boolean } = {}) {
    if (!botId) return;
    const needsTakeover = takeControl && !hasControl;
    try {
      const opened = await bootComputer({
        takeControl: needsTakeover,
        overlay: needsTakeover || computer?.state !== "running",
        force: computer?.state !== "running",
      });
      if (!opened || !refreshController.isActive()) return;
      setComputerOpen(true);
      setScreenError(null);
    } catch {
      // error already set
    }
  }

  async function releaseComputer(reason?: ComputerReleaseReason) {
    if (!botId || !refreshController.isActive()) return;
    const action = refreshController.beginAction();
    try {
      await rpc("computer/release", { botId, reason });
      if (!action.isActive()) return;
      setComputerOpen(false);
      await action.refresh().catch(() => undefined);
    } catch {
      if (action.isActive()) setScreenError(t("Could not continue"));
    } finally {
      action.finish();
    }
  }

  async function setComputerMode(mode: ComputerMode) {
    if (!botId || !refreshController.isActive() || mode === computer?.mode) return;
    const action = refreshController.beginAction();
    setSwitchingCount((count) => count + 1);
    setError(null);
    try {
      if (hasControl) {
        await rpc("computer/release", {
          botId,
          reason: computer?.takeoverRequested ? "skipped" : undefined,
        });
      }
      if (!action.isActive()) return;
      await rpc("bots/setComputer", { botId, mode });
      if (!action.isActive()) return;
      setComputer(null);
      setScreenUrl(null);
      autoBooted.current = null;
      await action.refresh();
    } catch (err) {
      if (!action.isActive()) return;
      setError(err instanceof Error ? err.message : t("Could not switch computer"));
    } finally {
      if (action.isActive()) setSwitchingCount((count) => count - 1);
      action.finish();
    }
  }

  const placeholder =
    screenError ?? previewPlaceholder(computer?.state, booting, name, computer?.mode);
  const openPreview = (
    <Pressable
      accessibilityLabel={t("Open computer")}
      onPress={() => void openComputer()}
      style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: tokens.background, padding: 24 }}>
      {error ? (
        <Text style={{ color: tokens.mutedForeground, marginBottom: 12 }}>{error}</Text>
      ) : null}
      <View
        style={{
          flex: 1,
          minHeight: 220,
          borderRadius: 14,
          overflow: "hidden",
          backgroundColor: tokens.card,
        }}
      >
        {computerOpen ? (
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: tokens.mutedForeground }}>{t("Open in full window")}</Text>
          </View>
        ) : computer?.state === "running" && embeddedScreenUrl && !screenError ? (
          <ScreenWebView
            url={embeddedScreenUrl}
            interactive={false}
            onError={onScreenError}
            effects={screenEffects}
            cover={openPreview}
          />
        ) : (
          <>
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
              <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
                {placeholder}
              </Text>
            </View>
            {openPreview}
          </>
        )}
      </View>
      <View
        style={{
          marginTop: 16,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <Text style={{ color: tokens.mutedForeground, flex: 1 }}>
          {controlLabel(computer, name, botId)}
        </Text>
        {hasControl ? (
          <ComputerReleaseActions
            takeoverRequested={computer?.takeoverRequested ?? false}
            onRelease={releaseComputer}
          />
        ) : computer?.busyBotName ? null : (
          <Pressable
            onPress={() => void openComputer({ takeControl: true })}
            style={{
              backgroundColor: tokens.muted,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: 12,
            }}
          >
            <Text style={{ color: tokens.foreground }}>{t("Take control")}</Text>
          </Pressable>
        )}
      </View>
      <ComputerModePicker
        value={computer?.mode}
        disabled={switching}
        onChange={(mode) => void setComputerMode(mode)}
      />

      <Modal
        visible={booting || computerOpen}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => {
          if (!booting) setComputerOpen(false);
        }}
      >
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          {booting ? (
            <SafeAreaView
              edges={["top", "left", "right"]}
              style={{
                flex: 1,
                backgroundColor: tokens.background,
                alignItems: "center",
                justifyContent: "center",
                gap: 22,
                padding: 24,
              }}
            >
              <Text
                style={{
                  color: tokens.foreground,
                  fontSize: 19,
                  fontWeight: "500",
                  textAlign: "center",
                }}
              >
                {t("Booting {label}", { label })}
              </Text>
              <View
                style={{
                  height: 5,
                  width: "70%",
                  maxWidth: 420,
                  overflow: "hidden",
                  borderRadius: 999,
                  backgroundColor: tokens.muted,
                }}
              >
                <View
                  style={{
                    height: "100%",
                    width: "66%",
                    borderRadius: 999,
                    backgroundColor: tokens.primary,
                  }}
                />
              </View>
            </SafeAreaView>
          ) : (
            <View style={{ flex: 1, backgroundColor: tokens.background }}>
              <SafeAreaView
                edges={["top", "left", "right"]}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  borderBottomWidth: 1,
                  borderBottomColor: tokens.border,
                  paddingHorizontal: 18,
                  paddingVertical: 14,
                }}
              >
                <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
                  <Text
                    numberOfLines={1}
                    style={{ color: tokens.foreground, fontSize: 15.5, fontWeight: "500" }}
                  >
                    {label}
                  </Text>
                  {hasControl ? (
                    <View
                      style={{
                        alignSelf: "flex-start",
                        borderRadius: 999,
                        backgroundColor: tokens.muted,
                        paddingHorizontal: 11,
                        paddingVertical: 4,
                      }}
                    >
                      <Text style={{ color: tokens.success, fontSize: 13 }}>
                        {t("You have control")}
                      </Text>
                    </View>
                  ) : null}
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                  {hasControl ? (
                    <ComputerReleaseActions
                      takeoverRequested={computer?.takeoverRequested ?? false}
                      onRelease={releaseComputer}
                    />
                  ) : computer?.busyBotName ? null : (
                    <Pressable
                      onPress={() =>
                        void bootComputer({ takeControl: true, overlay: false }).catch(
                          () => undefined,
                        )
                      }
                      hitSlop={8}
                      style={{
                        borderWidth: 1,
                        borderColor: tokens.border,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: 10,
                        minHeight: 44,
                        justifyContent: "center",
                      }}
                    >
                      <Text style={{ color: tokens.foreground }}>{t("Take control")}</Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityLabel={t("Close computer")}
                    hitSlop={8}
                    onPress={() => setComputerOpen(false)}
                    style={{
                      minWidth: 44,
                      minHeight: 44,
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <NativeSymbol
                      ios="xmark"
                      android="close"
                      size={16}
                      color={tokens.mutedForeground}
                    />
                  </Pressable>
                </View>
              </SafeAreaView>
              <View style={{ flex: 1, backgroundColor: tokens.card }}>
                {computer?.state === "running" && embeddedScreenUrl && !screenError ? (
                  <ScreenWebView
                    url={embeddedScreenUrl}
                    interactive={hasControl}
                    onError={onScreenError}
                    effects={screenEffects}
                  />
                ) : (
                  <View
                    style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}
                  >
                    <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
                      {placeholder}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          )}
        </SafeAreaProvider>
      </Modal>
    </View>
  );
}

function ComputerReleaseActions({
  takeoverRequested,
  onRelease,
}: {
  takeoverRequested: boolean;
  onRelease: (reason?: ComputerReleaseReason) => Promise<void>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const actions: Array<{ label: string; reason?: ComputerReleaseReason; primary?: boolean }> =
    takeoverRequested
      ? [
          { label: t("Skip"), reason: "skipped" },
          { label: t("I’m done"), reason: "done", primary: true },
        ]
      : [{ label: t("Release") }];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityLabel={action.label}
          onPress={() => void onRelease(action.reason)}
          hitSlop={8}
          style={{
            minHeight: 44,
            justifyContent: "center",
            borderWidth: 1,
            borderColor: action.primary ? tokens.primary : tokens.border,
            backgroundColor: action.primary ? tokens.primary : tokens.muted,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 10,
          }}
        >
          <Text style={{ color: action.primary ? tokens.primaryForeground : tokens.foreground }}>
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** `cover` sits over a live screen only, so a failed screen keeps its retry reachable. */
function ScreenWebView({
  url,
  interactive,
  onError,
  effects,
  cover,
}: {
  url: string;
  interactive: boolean;
  onError: () => void;
  effects: ReturnType<typeof screenLinkEffects>;
  cover?: ReactNode;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ScreenSession
      key={`${url}#${attempt}`}
      url={url}
      interactive={interactive}
      onError={onError}
      effects={effects}
      cover={cover}
      onRetry={() => {
        // Bumped once the forced read settles, in the same render as any new URL, so a retry
        // remounts once whether the read returns a new URL, the same one, or fails.
        void effects.onReload().then(() => setAttempt((count) => count + 1));
      }}
    />
  );
}

function ScreenSession({
  url,
  interactive,
  onError,
  effects,
  cover,
  onRetry,
}: {
  url: string;
  interactive: boolean;
  onError: () => void;
  effects: ReturnType<typeof screenLinkEffects>;
  cover?: ReactNode;
  onRetry: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const { view, webViewProps } = useScreenLink(url, effects);
  if (view === "failed") {
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 16 }}
      >
        <Text style={{ color: tokens.mutedForeground, textAlign: "center" }}>
          {t("Could not load the desktop. This device cannot reach the screen URL.")}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          style={{
            minHeight: 44,
            justifyContent: "center",
            backgroundColor: tokens.muted,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 12,
          }}
        >
          <Text style={{ color: tokens.foreground }}>{t("Try again.")}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={{ flex: 1 }}>
      <WebView
        // ponytail: headers only reach the top-level load, so noVNC subresources and its
        // websocket still go out bare. Enough for a service-token origin (Access lets the
        // whole session through after the first request); needs a signed cookie bounce if
        // Cloudflare ever starts challenging them individually.
        source={{ uri: url, headers: currentAccessHeaders(currentApiBase(), defaultApiBase()) }}
        style={{ flex: 1, backgroundColor: tokens.background }}
        pointerEvents={interactive && view === "none" ? "auto" : "none"}
        javaScriptEnabled
        domStorageEnabled
        keyboardDisplayRequiresUserAction={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        scrollEnabled={false}
        overScrollMode="never"
        onError={onError}
        onHttpError={onError}
        {...webViewProps}
      />
      {view === "connecting" || view === "reconnecting" ? <ScreenLinkOverlay view={view} /> : null}
      {cover}
    </View>
  );
}
