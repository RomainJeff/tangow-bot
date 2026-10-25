import type { AskDraft, MessageBlock } from "@rakazo/contracts";
import type { DraftLocal } from "@rakazo/core";
import {
  conversationLabel,
  DRAFT_UNDO_MS,
  draftAddresses,
  draftCardView,
  draftChanges,
  draftPrimaryAction,
  draftSentTo,
} from "@rakazo/core";
import { radii, sizes } from "@rakazo/ui-tokens";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Image, Pressable, Share, StyleSheet, Text, View } from "react-native";
import Animated, { withTiming } from "react-native-reanimated";
import { SvgUri } from "react-native-svg";
import { mobileTokens } from "../lib/appearance";
import { CHAT_MOTION, useChatReducedMotion, usePressScaleStyle } from "../lib/chat-motion";
import type { CardEdits } from "../lib/draft-edit";
import {
  draftEdit,
  draftEditTarget,
  dropDraftEdit,
  openDraftEdit,
  subscribeDraftEdit,
} from "../lib/draft-edit";
import { dateLocaleForUi, useI18n } from "../lib/i18n";
import { userInitials } from "../lib/inbox";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { useProfilePhoto } from "../lib/profile-photo";
import { nativeTextStyle } from "../lib/typography";
import { CapsuleButton } from "./AskActions";
import { FramedBlock } from "./framed-block";
import { NativeSymbol } from "./native-symbol";
import { UserAvatar } from "./user-avatar";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

const ROLES = ["to", "cc", "bcc"] as const;
const LOGO_SIZE = 20;
const AVATAR_SIZE = 24;
// Undo is one line of meta text: the slop grows its target to a 48 pt action's height.
const UNDO_LINE = nativeTextStyle("meta").lineHeight;
const UNDO_HIT_SLOP = {
  top: (sizes.mobileAction - UNDO_LINE) / 2,
  bottom: (sizes.mobileAction - UNDO_LINE) / 2,
  left: 8,
  right: 16,
};

/** The app's catalog logo, or its first letter when it has none or it fails to load. */
export function AppLogo({ app }: { app: AskDraft["app"] }) {
  const styles = useThemedStyles(createStyles);
  const [failed, setFailed] = useState<string | null>(null);
  const uri = app.logo && app.logo !== failed ? app.logo : null;
  if (!uri) {
    return (
      <View accessibilityElementsHidden style={[styles.logo, styles.logoLetter]}>
        <Text style={styles.logoLetterText}>{app.name.slice(0, 1).toUpperCase()}</Text>
      </View>
    );
  }
  return /\.svg(?:[?#]|$)/i.test(uri) ? (
    <SvgUri uri={uri} width={LOGO_SIZE} height={LOGO_SIZE} onError={() => setFailed(uri)} />
  ) : (
    <Image
      accessibilityElementsHidden
      source={{ uri }}
      resizeMode="contain"
      onError={() => setFailed(uri)}
      style={styles.logo}
    />
  );
}

/** The text with its sender in front of it: the mail leaves in the run owner's name. */
function Sender({
  owner,
  own,
  children,
}: {
  owner: AskDraft["owner"];
  own: boolean;
  children: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  const photo = useProfilePhoto();
  return (
    <View style={styles.sender}>
      <UserAvatar
        initials={userInitials(owner?.name ?? "")}
        image={own ? photo : null}
        size={AVATAR_SIZE}
        style={styles.avatar}
      />
      {children}
    </View>
  );
}

function StateMark({ tone, label }: { tone: "ink" | "destructive"; label: string }) {
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const color = tone === "destructive" ? tokens.destructive : tokens.foreground;
  return (
    <View style={styles.mark}>
      <View style={[styles.markDot, { backgroundColor: color }]} />
      <Text style={[styles.markText, { color }]}>{label}</Text>
    </View>
  );
}

function RoundAction({
  label,
  ios,
  android,
  disabled,
  onPress,
}: {
  label: string;
  ios: string;
  android: Parameters<typeof NativeSymbol>[0]["android"];
  disabled: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  const reducedMotion = useChatReducedMotion();
  const { scale, style: pressScaleStyle } = usePressScaleStyle();
  const press = (to: number) => {
    if (!reducedMotion) scale.value = withTiming(to, { duration: CHAT_MOTION.capsulePressMs });
  };
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => press(CHAT_MOTION.capsulePressScale)}
      onPressOut={() => press(1)}
      style={[styles.round, disabled ? styles.disabled : undefined, pressScaleStyle]}
    >
      <NativeSymbol ios={ios} android={android} size={17} />
    </AnimatedPressable>
  );
}

/**
 * A message the bot wrote in the person's name, shown as it will leave: every recipient, the subject
 * and the text, which the Edit message sheet changes before Send. A chat message names its one
 * recipient as its app did. Mirrors
 * `apps/web/src/components/DraftCard.tsx`.
 */
export function DraftCard({
  threadKey,
  block,
  draft,
  messageId,
  canAnswer,
  viewerUserId,
  onAnswer,
  onReconnect,
}: {
  threadKey: string;
  block: AskBlock;
  draft: AskDraft;
  /** The card's thread item: its edits are kept under it. */
  messageId: string;
  canAnswer: boolean;
  viewerUserId?: string;
  onAnswer: (answer: string, edits?: CardEdits) => Promise<void>;
  onReconnect: () => void;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const edit = useSyncExternalStore(subscribeDraftEdit, () => draftEdit(messageId));
  const editing = useSyncExternalStore(
    subscribeDraftEdit,
    () => draftEditTarget()?.messageId === messageId,
  );
  const [pending, setPending] = useState<DraftLocal["pending"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnectOpened, setReconnectOpened] = useState(false);
  // Opening Reconnect answers one failure only: a send, or a card without a failure, starts over.
  if (reconnectOpened && !draft.failure) setReconnectOpened(false);
  const discardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitDiscardRef = useRef<() => void>(() => undefined);

  const text = edit?.text ?? draft.body;
  // The card shows the mail as it will leave, with the sheet's changes.
  const shown: AskDraft = {
    ...draft,
    recipients: edit?.recipients ?? draft.recipients,
    subject: edit?.subject ?? draft.subject,
  };
  const changes = draftChanges(draft, edit);
  const edited = Object.keys(changes).length > 0;
  const sendable =
    text.trim() !== "" && shown.recipients.some((recipient) => recipient.role === "to");
  const own = !draft.owner || draft.owner.userId === viewerUserId;
  const view = draftCardView(
    { ...block, draft },
    { edited, focused: editing, pending, canAnswer, owner: own },
  );

  async function send() {
    if (pending || !sendable) return;
    setReconnectOpened(false);
    setPending("send");
    setError(null);
    try {
      await onAnswer("allow", edited ? changes : undefined);
      dropDraftEdit(messageId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not submit answer"));
    } finally {
      setPending(null);
    }
  }

  async function commitDiscard() {
    discardTimer.current = null;
    setPending("discarding");
    try {
      await onAnswer("deny");
      dropDraftEdit(messageId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("Could not submit answer"));
    } finally {
      setPending(null);
    }
  }
  commitDiscardRef.current = () => void commitDiscard();

  function discard() {
    if (pending) return;
    setError(null);
    setPending("discard");
    discardTimer.current = setTimeout(() => commitDiscardRef.current(), DRAFT_UNDO_MS);
  }

  function undo() {
    if (!discardTimer.current) return;
    clearTimeout(discardTimer.current);
    discardTimer.current = null;
    setPending(null);
  }

  // Leaving the thread inside the Undo window still discards: the person asked for it.
  useEffect(
    () => () => {
      if (!discardTimer.current) return;
      clearTimeout(discardTimer.current);
      commitDiscardRef.current();
    },
    [],
  );

  const app = draft.app.name;
  const header = {
    who: draft.app.account ? `${app} · ${draft.app.account}` : app,
    icon: <AppLogo app={draft.app} />,
  };

  if (view.kind === "sent") {
    const time = new Intl.DateTimeFormat(dateLocaleForUi(), {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(view.at));
    return (
      <FramedBlock
        header={header}
        lead={
          <Sender owner={draft.owner} own={own}>
            <Text style={styles.sentBody}>{draft.body}</Text>
          </Sender>
        }
        answered={t("Sent to {recipient} · {time}", { recipient: draftSentTo(draft), time })}
      />
    );
  }

  if (view.kind !== "open") {
    const state =
      view.kind === "discarded" ? (
        view.undo ? (
          <View style={styles.discarded}>
            <Text style={styles.answeredText}>{t("Discarded")} ·</Text>
            <Pressable accessibilityRole="button" hitSlop={UNDO_HIT_SLOP} onPress={undo}>
              <Text style={[styles.answeredText, styles.undo]}>{t("Undo")}</Text>
            </Pressable>
          </View>
        ) : (
          t("Discarded")
        )
      ) : view.kind === "replaced" ? (
        t("Replaced")
      ) : (
        t("No longer active")
      );
    return <FramedBlock answered={state} answeredMark={<AppLogo app={draft.app} />} />;
  }

  const roleLabel = { to: t("To"), cc: t("Cc"), bcc: t("Bcc") };
  const chat = draft.conversation && conversationLabel(draft.conversation);
  const lines = ROLES.flatMap((role) => {
    const addresses = draftAddresses(shown, role);
    if (!addresses) return [];
    return [
      <Text key={role} style={role === "to" ? undefined : styles.detail}>
        <Text style={styles.label}>{roleLabel[role]}</Text> {chat ? chat.name : addresses}
        {chat?.handle ? <Text style={styles.label}> @{chat.handle}</Text> : null}
      </Text>,
    ];
  });
  if (shown.subject) {
    lines.push(
      <Text key="subject" style={styles.detail}>
        <Text style={styles.label}>{t("Subject")}</Text> {shown.subject}
      </Text>,
    );
  }
  const status =
    view.status === "not_sent" ? (
      <StateMark tone="destructive" label={t("Not sent")} />
    ) : view.status === "editing" ? (
      <StateMark tone="ink" label={t("Editing")} />
    ) : view.status === "edited" ? (
      <StateMark tone="ink" label={t("Edited")} />
    ) : undefined;
  const primary = draftPrimaryAction(view.failure, reconnectOpened);
  const reason = view.failure?.disconnected
    ? t("{app} is disconnected.", { app })
    : view.failure?.reason;
  const editable = !view.readOnly && !view.sending;

  return (
    <FramedBlock
      header={{ ...header, status }}
      question={lines.flatMap((line, index) => (index ? ["\n", line] : [line]))}
      actions={
        view.readOnly ? undefined : (
          <View style={styles.actionRow}>
            <RoundAction
              label={t("Discard")}
              ios="trash"
              android="trash-outline"
              disabled={view.sending}
              onPress={discard}
            />
            <RoundAction
              label={t("Share")}
              ios="square.and.arrow.up"
              android="share-outline"
              disabled={view.sending}
              onPress={() => void Share.share({ message: text }).catch(() => undefined)}
            />
            <View style={styles.primary}>
              {primary === "reconnect" ? (
                <CapsuleButton
                  kind="primary"
                  height={sizes.mobileAction}
                  label={t("Reconnect {app}", { app })}
                  onPress={() => {
                    setReconnectOpened(true);
                    onReconnect();
                  }}
                />
              ) : (
                <CapsuleButton
                  kind="primary"
                  height={sizes.mobileAction}
                  disabled={view.sending || !sendable}
                  onPress={() => void send()}
                  icon={
                    <NativeSymbol
                      ios="lock.fill"
                      android="lock-closed"
                      size={13}
                      color={tokens.primaryForeground}
                    />
                  }
                  label={
                    view.sending
                      ? t("Sending…")
                      : primary === "try_again"
                        ? t("Try again")
                        : t("Send")
                  }
                />
              )}
            </View>
          </View>
        )
      }
    >
      <View style={styles.content}>
        <Sender owner={draft.owner} own={own}>
          <Pressable
            accessibilityRole={editable ? "button" : undefined}
            accessibilityHint={editable ? t("Edit message") : undefined}
            disabled={!editable}
            onPress={() => openDraftEdit(router, { threadKey, messageId, draft })}
            style={styles.well}
          >
            <Text style={[styles.body, view.sending ? styles.frozen : undefined]}>{text}</Text>
            {editable ? (
              <View style={styles.pencil}>
                <NativeSymbol
                  ios="pencil"
                  android="pencil-outline"
                  size={14}
                  color={tokens.mutedForeground}
                />
              </View>
            ) : null}
          </Pressable>
        </Sender>
        {reason ? <Text style={styles.note}>{reason}</Text> : null}
        {error ? (
          <Text accessibilityRole="alert" style={[styles.note, styles.error]}>
            {error}
          </Text>
        ) : null}
      </View>
    </FramedBlock>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    logo: { width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: radii.chip },
    logoLetter: {
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.well,
    },
    logoLetterText: { color: tokens.foreground, ...nativeTextStyle("label") },
    sender: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    avatar: { marginTop: 12 },
    mark: { flexDirection: "row", alignItems: "center", gap: 6 },
    markDot: { width: 6, height: 6, borderRadius: 3 },
    markText: nativeTextStyle("blockHeader"),
    label: { color: tokens.mutedForeground, fontWeight: "400" },
    detail: { color: tokens.foreground, ...nativeTextStyle("body") },
    content: { gap: 8 },
    well: {
      flex: 1,
      minWidth: 0,
      paddingStart: 16,
      paddingEnd: 36,
      paddingVertical: 12,
      borderRadius: radii.card,
      backgroundColor: tokens.well,
    },
    body: { color: tokens.foreground, ...nativeTextStyle("composer") },
    frozen: { color: tokens.mutedForeground },
    pencil: { position: "absolute", top: 12, end: 12 },
    sentBody: { flexShrink: 1, color: tokens.foreground, ...nativeTextStyle("body") },
    note: {
      paddingStart: AVATAR_SIZE + 12,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta"),
    },
    error: { color: tokens.destructive },
    answeredText: { color: tokens.mutedForeground, ...nativeTextStyle("meta") },
    discarded: { flexDirection: "row", alignItems: "center", gap: 4 },
    undo: {
      color: tokens.foreground,
      textDecorationLine: "underline",
      textDecorationColor: tokens.border,
    },
    actionRow: { flexDirection: "row", gap: 8 },
    round: {
      width: sizes.mobileAction,
      height: sizes.mobileAction,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: tokens.secondary,
    },
    disabled: { opacity: 0.5 },
    primary: { flex: 1 },
  });
}
