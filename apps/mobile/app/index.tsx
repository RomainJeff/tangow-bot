import { normalizeCreateBotProfile } from "@rakazo/contracts";
import { Redirect, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AmbientBackground, ThreadScrollEdge } from "../components/ambient-background";
import { BotOrganizeSheet } from "../components/bot-organize-sheet";
import { GlassBackdrop } from "../components/glass";
import { CircleButton } from "../components/home/circle-button";
import { ActivitySection, BotRow, GroupRow, SearchRow } from "../components/home/rows";
import { createHomeStyles } from "../components/home/styles";
import { NativeMenu } from "../components/native-menu";
import { NativeSymbol } from "../components/native-symbol";
import { UserAvatar } from "../components/user-avatar";
import type { MobileBot } from "../lib/api";
import { currentApiBase, loadSessionToken, rpc, selectedSpaceId, selectSpace } from "../lib/api";
import { mobileTokens, resolveMobileAppearance } from "../lib/appearance";
import { allowFocusPrompt, scheduleFocusPrompt } from "../lib/focus-prompt";
import { selectionHaptic } from "../lib/haptics";
import { t, useI18n } from "../lib/i18n";
import { userInitials } from "../lib/inbox";
import type { InboxSpace } from "../lib/inbox-spaces";
import { canDeleteInboxSpace } from "../lib/inbox-spaces";
import { dismissThreadNotifications, resumeLiveNotifications } from "../lib/live-notifications";
import { native, useThemedStyles } from "../lib/native";
import type { MenuAction } from "../lib/native-menu";
import { useProfilePhoto } from "../lib/profile-photo";
import { mobileSearchDestination } from "../lib/search-destination";
import { openSheet } from "../lib/sheet";
import type { InboxItem } from "../lib/use-home-inbox";
import { useHomeInbox } from "../lib/use-home-inbox";

async function openMobileSpace(spaceId: string | undefined, open: () => void) {
  if (spaceId && !(await selectSpace(spaceId))) {
    Alert.alert(t("Could not switch spaces"), t("Try again."));
    return;
  }
  open();
}

export default function Home() {
  const tokens = mobileTokens();
  const appearance = resolveMobileAppearance();
  const styles = useThemedStyles(createHomeStyles);
  const { t } = useI18n();
  const {
    bots,
    groups,
    botSections,
    me,
    error,
    setError,
    ready,
    hasSession,
    refreshing,
    query,
    setQuery,
    searching,
    setSearching,
    setSearchHits,
    searchLoading,
    activityMode,
    toggleActivityMode,
    activity,
    spaceActionRef,
    spaceBusy,
    spaceRecoveryId,
    loadBots,
    refreshBots,
    loadActivity,
    listData,
    chooseInboxSpace,
    deleteInboxSpace,
  } = useHomeInbox();
  const creatingBotRef = useRef(false);
  const initials = userInitials(me?.name ?? "");
  const userImage = useProfilePhoto();
  const insets = useSafeAreaInsets();
  // The header and search field's height, measured: the list starts below it and runs under it.
  const [topHeight, setTopHeight] = useState(Math.max(insets.top, 20) + 62);
  const router = useRouter();

  function organize(kind: "bot" | "group", id: string) {
    const chat =
      kind === "bot" ? bots.find((bot) => bot.id === id) : groups.find((group) => group.id === id);
    if (!chat) return;
    selectionHaptic();
    openSheet(
      router,
      (close) => (
        <BotOrganizeSheet
          bot={chat}
          sections={botSections}
          onClose={close}
          onUpdate={async (update) => {
            await rpc(`${kind}s/update`, { [`${kind}Id`]: chat.id, ...update });
            if (kind === "bot" && update.notifyOnFinish !== undefined) {
              await resumeLiveNotifications(
                currentApiBase(),
                await loadSessionToken(),
                selectedSpaceId() ?? "",
              ).catch(() => undefined);
              if (!update.notifyOnFinish && "threadId" in chat) {
                await dismissThreadNotifications({ threadId: chat.threadId }).catch(
                  () => undefined,
                );
              }
            }
            await loadBots();
          }}
          onCreateSection={async (name) => {
            await rpc("botSections/create", { [`${kind}Id`]: chat.id, name });
            await loadBots();
          }}
          onRenameSection={async (sectionId, name) => {
            await rpc("botSections/update", { sectionId, name });
            await loadBots();
          }}
        />
      ),
      { background: native.fillPressed },
    );
  }

  function confirmDeleteSpace(space: InboxSpace) {
    Alert.alert(
      t("Delete {name}?", { name: space.name }),
      t("This removes the empty space for everyone."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () => void deleteInboxSpace(space),
        },
      ],
    );
  }

  function showSpaceActions(space: InboxSpace) {
    if (
      !canDeleteInboxSpace(space) ||
      spaceActionRef.current.busy ||
      spaceActionRef.current.recoveryId
    )
      return;
    Alert.alert(space.name, undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete space"),
        style: "destructive",
        onPress: () => confirmDeleteSpace(space),
      },
    ]);
  }

  function showCreateMenu() {
    if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
    Alert.alert(t("Create"), undefined, [
      ...createActions.map(({ label, onPress }) => ({ text: label, onPress })),
      { text: t("Cancel"), style: "cancel" },
    ]);
  }

  const createQuickBot = useCallback(async () => {
    if (creatingBotRef.current || spaceActionRef.current.busy || spaceActionRef.current.recoveryId)
      return;
    creatingBotRef.current = true;
    try {
      // Authoritative roster so a slow home fetch does not treat later bots as first.
      // A failed list is unknown — use the delayed path rather than assuming first.
      const existing = await rpc<MobileBot[]>("bots/list").catch(() => null);
      const isFirstBot = existing !== null && existing.length === 0;
      const bot = await rpc<MobileBot>("bots/create", {
        ...normalizeCreateBotProfile({ name: "New Bot", title: "", description: "" }),
        notifyOnFinish: true,
        computerMode: "team",
      });
      void refreshBots().catch(() => undefined);
      allowFocusPrompt(bot.id);
      router.push({ pathname: "/thread", params: { botId: bot.id, name: bot.name } });
      void (async () => {
        const started = await rpc("onboarding/start", { botId: bot.id })
          .then(() => true)
          .catch(() => false);
        if (!started) return;
        scheduleFocusPrompt(bot.id, isFirstBot);
      })();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not create bot"));
    } finally {
      creatingBotRef.current = false;
    }
  }, [refreshBots, router, t]);

  const createActions: MenuAction[] = [
    { label: t("New bot"), onPress: () => void createQuickBot() },
    { label: t("New group"), onPress: () => router.push("/new-group") },
    { label: t("New space"), onPress: () => router.push("/new-space") },
  ];

  if (!ready) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }
  if (!hasSession) return <Redirect href="/sign-in" />;

  return (
    <View style={styles.screen}>
      <AmbientBackground />
      <FlatList<InboxItem>
        data={listData}
        keyExtractor={(item) => {
          if (item.type === "heading") return `heading-${item.key}`;
          if (item.type === "bot") return item.bot.id;
          if (item.type === "group") return `group-${item.group.id}`;
          const hit = item.hit;
          return `${hit.kind}-${hit.botId ?? hit.groupId}-${hit.messageId ?? hit.artifactId ?? hit.routineId ?? hit.url}`;
        }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        indicatorStyle={appearance === "dark" ? "white" : "black"}
        contentContainerStyle={[styles.list, { paddingTop: topHeight }]}
        scrollIndicatorInsets={{ top: topHeight }}
        // iOS would add the safe area on top, which `topHeight` already holds.
        automaticallyAdjustsScrollIndicatorInsets={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void refreshBots();
              void loadActivity();
            }}
            progressViewOffset={topHeight}
            tintColor={native.secondaryLabel}
            colors={[tokens.mutedForeground]}
            progressBackgroundColor={tokens.muted}
          />
        }
        ListHeaderComponent={
          activityMode &&
          !searching &&
          !query.trim() &&
          (activity.active.length > 0 || activity.recent.length > 0) ? (
            <ActivitySection activity={activity} bots={bots} />
          ) : null
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {query.trim() && searching
              ? searchLoading
                ? t("Searching…")
                : t("No results")
              : query.trim()
                ? t("No matching bots")
                : searching
                  ? t("Search conversations, files, and routines")
                  : t("Tap + to create a bot")}
          </Text>
        }
        renderItem={({ item }) =>
          item.type === "search" ? (
            <SearchRow
              hit={item.hit}
              onPress={() => {
                setQuery("");
                setSearchHits([]);
                router.push(mobileSearchDestination(item.hit));
              }}
            />
          ) : item.type === "heading" ? (
            item.space ? (
              <View style={styles.spaceHeading}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={item.title}
                  accessibilityState={{
                    selected: item.space.id === me?.spaceId,
                    disabled: spaceBusy,
                  }}
                  disabled={spaceBusy}
                  onPress={() => {
                    if (item.space) void chooseInboxSpace(item.space.id);
                  }}
                  style={({ pressed }) => [styles.spaceSelect, pressed && styles.rowPressed]}
                >
                  <Text style={styles.spaceTitle}>{item.title}</Text>
                </Pressable>
                {canDeleteInboxSpace(item.space) ? (
                  <NativeMenu
                    compact
                    title={item.title}
                    accessibilityLabel={t("Space actions for {name}", { name: item.title })}
                    disabled={spaceBusy || !!spaceRecoveryId}
                    actions={[
                      {
                        label: t("Delete space"),
                        destructive: true,
                        onPress: () => {
                          if (item.space) confirmDeleteSpace(item.space);
                        },
                      },
                    ]}
                    onAndroidOpen={() => {
                      if (item.space) showSpaceActions(item.space);
                    }}
                    style={({ pressed }) => [styles.spaceActions, pressed && styles.rowPressed]}
                  >
                    <NativeSymbol ios="ellipsis" android="ellipsis-horizontal" size={20} />
                  </NativeMenu>
                ) : null}
              </View>
            ) : (
              <Text style={styles.sectionHeading}>{item.title}</Text>
            )
          ) : item.type === "group" ? (
            <GroupRow
              group={item.group}
              userInitials={initials}
              userImage={userImage}
              onPress={() => {
                if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
                void openMobileSpace(item.group.spaceId, () =>
                  router.push({
                    pathname: "/group-thread",
                    params: { groupId: item.group.id, name: item.group.name },
                  }),
                );
              }}
              onLongPress={
                item.group.spaceId === me?.spaceId
                  ? () => organize("group", item.group.id)
                  : undefined
              }
            />
          ) : (
            <BotRow
              bot={item.bot}
              onPress={() => {
                if (spaceActionRef.current.busy || spaceActionRef.current.recoveryId) return;
                void openMobileSpace(item.bot.spaceId, () =>
                  router.push({
                    pathname: "/thread",
                    params: { botId: item.bot.id, name: item.bot.name },
                  }),
                );
              }}
              onLongPress={
                item.bot.spaceId === me?.spaceId ? () => organize("bot", item.bot.id) : undefined
              }
            />
          )
        }
      />
      {/* The list runs under the header and fades out beneath the capsule, as the thread does. */}
      <ThreadScrollEdge height={topHeight + 24} />
      <View
        onLayout={(event) => setTopHeight(Math.round(event.nativeEvent.layout.height))}
        style={[styles.top, { paddingTop: Math.max(insets.top, 20) }]}
      >
        <View style={styles.header}>
          {/* The avatar covers a CircleButton's fill, so it dims on press instead. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Settings")}
            onPress={() => router.push("/account")}
            hitSlop={4}
            style={({ pressed }) => pressed && styles.avatarPressed}
          >
            <UserAvatar initials={initials} image={userImage} size={40} fontSize={15} />
          </Pressable>
          <View style={styles.headerActions}>
            <GlassBackdrop radius={22} />
            <CircleButton
              accessibilityLabel={t("Activity")}
              active={activityMode}
              accent
              onPress={toggleActivityMode}
            >
              <NativeSymbol
                ios={activityMode ? "bell.fill" : "bell"}
                android={activityMode ? "notifications" : "notifications-outline"}
                size={17}
                color={activityMode ? tokens.primaryForeground : tokens.foreground}
              />
            </CircleButton>
            <CircleButton
              accessibilityLabel={t("Search")}
              active={searching}
              onPress={() =>
                setSearching((open) => {
                  if (open) setQuery("");
                  return !open;
                })
              }
            >
              <NativeSymbol ios="magnifyingglass" android="search" size={17} />
            </CircleButton>
            <NativeMenu
              compact
              title={t("Create")}
              accessibilityLabel={t("Create")}
              disabled={spaceBusy || !!spaceRecoveryId}
              actions={createActions}
              onAndroidOpen={showCreateMenu}
              hitSlop={4}
              style={({ pressed }) => [styles.circleButton, pressed && styles.circlePressed]}
            >
              <NativeSymbol ios="plus" android="add" size={18} />
            </NativeMenu>
          </View>
        </View>

        {searching ? (
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={t("Search")}
            placeholderTextColor={tokens.mutedForeground}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            keyboardAppearance={appearance}
            clearButtonMode="while-editing"
            style={styles.searchField}
          />
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}
        {spaceRecoveryId ? (
          <Pressable
            accessibilityRole="button"
            disabled={spaceBusy}
            onPress={() => void chooseInboxSpace(spaceRecoveryId)}
            style={styles.recoveryAction}
          >
            <Text style={styles.spaceTitle}>{t("Try again.")}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
