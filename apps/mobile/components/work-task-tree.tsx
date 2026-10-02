import { ChatMarkdown, truncateMarkdownForRender } from "@rakazo/chat-ui/native";
import type { PendingWorkAsk, TaskTreeNode } from "@rakazo/contracts";
import { taskCount, taskLineState } from "@rakazo/core";
import { sizes } from "@rakazo/ui-tokens";
import { useRouter } from "expo-router";
import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { MobileMe } from "../lib/api";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { presentMessageActionSheet } from "../lib/message-action-sheet";
import { useMobileTokens, useResolvedAppearance, useThemedStyles } from "../lib/native";
import { openSheet } from "../lib/sheet";
import type { TaskMenuAction } from "../lib/task-tree-view";
import {
  approvalLine,
  cancelPrompt,
  engineLine,
  taskMenuActions,
  taskMenuLabel,
  tasksLinkLabel,
} from "../lib/task-tree-view";
import { nativeTextStyle } from "../lib/typography";
import { workStateColor, workStateGlyph, workStateLabel } from "../lib/work-cards";
import { NativeSymbol } from "./native-symbol";
import { WorkThreadSheet } from "./work-thread-sheet";

type WorkTreeApi = {
  tree: TaskTreeNode[] | null;
  /** The card the tree is unfolded under; one at a time. */
  openAnchor: string | null;
  ownerName: string | null;
  toggle: (anchor: string) => void;
  /** Settles a delegated approval from its card in the thread; the tree only shows it. */
  answer: (work: PendingWorkAsk, answer: string) => Promise<void>;
  cancel: (node: TaskTreeNode) => void;
  close: (node: TaskTreeNode) => void;
  viewThread: (node: TaskTreeNode) => void;
};

const WorkTreeContext = createContext<WorkTreeApi | null>(null);

export function WorkTreeProvider({ api, children }: { api: WorkTreeApi; children: ReactNode }) {
  return <WorkTreeContext.Provider value={api}>{children}</WorkTreeContext.Provider>;
}

/**
 * The coordinator thread's task tree and what the owner can do with it, read from the
 * server whenever the thread shows a delegated card. The backend decides what a task may
 * do; the screen only expresses the intent and renders the result.
 */
export function useWorkTree({
  threadId,
  enabled,
  refresh,
}: {
  threadId: string | undefined;
  /** Whether the thread has a card the tree can unfold under. */
  enabled: boolean;
  /** Reloads the thread snapshot, which holds the pending asks. */
  refresh: () => Promise<unknown>;
}): { api: WorkTreeApi; reload: () => void } {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  // Both are kept with the thread they belong to: another thread has other tasks.
  const [loaded, setLoaded] = useState<{ threadId: string; tree: TaskTreeNode[] } | null>(null);
  const [opened, setOpened] = useState<{ threadId: string; anchor: string } | null>(null);
  const [version, setVersion] = useState(0);
  const [ownerName, setOwnerName] = useState<string | null>(null);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  // The latest reload of the snapshot, without making the tree's api change with every render.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const tree = loaded && loaded.threadId === threadId ? loaded.tree : null;
  const openAnchor = opened && opened.threadId === threadId ? opened.anchor : null;

  useEffect(() => {
    if (!threadId || !enabled) return;
    let cancelled = false;
    void rpc<TaskTreeNode[]>("works/tree", { threadId })
      .then((next) => {
        if (!cancelled) setLoaded({ threadId, tree: next });
      })
      // A failed read keeps the tree already shown; the next event reads it again.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [threadId, enabled, version]);

  // Settled approvals name who decided them; the name is only read once a tree is opened.
  const hasOpened = openAnchor !== null;
  useEffect(() => {
    if (!hasOpened || ownerName !== null) return;
    void rpc<MobileMe>("me")
      .then((me) => setOwnerName(me.name || null))
      .catch(() => undefined);
  }, [hasOpened, ownerName]);

  const fail = useCallback(
    (error: unknown) =>
      Alert.alert(
        t("Could not complete action"),
        error instanceof Error ? error.message : t("Try again."),
      ),
    [t],
  );

  const api = useMemo<WorkTreeApi>(
    () => ({
      tree,
      openAnchor,
      ownerName,
      toggle: (anchor) => {
        if (!threadId) return;
        if (openAnchor !== anchor) reload();
        setOpened(openAnchor === anchor ? null : { threadId, anchor });
      },
      answer: async (work, answer) => {
        await rpc("works/answer", {
          workId: work.workId,
          runId: work.runId,
          messageId: work.message.id,
          answer,
        });
        await refreshRef.current();
        reload();
      },
      cancel: (node) => {
        const { title, message } = cancelPrompt(node);
        Alert.alert(title, message, [
          { text: t("Keep"), style: "cancel" },
          {
            text: t("Cancel task"),
            style: "destructive",
            onPress: () =>
              void rpc("works/cancel", { workId: node.workId })
                .then(reload, fail)
                .then(() => refreshRef.current().catch(() => undefined)),
          },
        ]);
      },
      close: (node) =>
        void rpc("works/close", { workId: node.workId })
          .then(reload, fail)
          .then(() => refreshRef.current().catch(() => undefined)),
      viewThread: (node) => {
        const owner = `work:${node.workId}`;
        openSheet(
          router,
          (closeThread) => (
            <WorkThreadSheet
              workId={node.workId}
              name={node.executor.name || t("Specialist")}
              close={closeThread}
            />
          ),
          { owner, background: tokens.popover },
        );
      },
    }),
    [tree, openAnchor, ownerName, threadId, reload, fail, router, t, tokens.popover],
  );
  return { api, reload };
}

/**
 * The quiet "N tasks" link under a delegated card, and under it, when unfolded, the compact
 * tree of the thread's tasks. Renders nothing while the thread has none.
 */
export function WorkTreeAnchor({ anchor }: { anchor: string }) {
  const api = useContext(WorkTreeContext);
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  useI18n();
  if (!api?.tree?.length) return null;
  const open = api.openAnchor === anchor;
  const label = tasksLinkLabel(taskCount(api.tree));
  return (
    <View style={styles.anchor}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open }}
        hitSlop={10}
        onPress={() => api.toggle(anchor)}
        style={styles.disclosure}
      >
        <Text style={styles.meta}>{label}</Text>
        <NativeSymbol
          ios={open ? "chevron.down" : "chevron.right"}
          android={open ? "chevron-down-outline" : "chevron-forward-outline"}
          size={sizes.receipt}
          color={tokens.mutedForeground}
        />
      </Pressable>
      {open ? <TaskList nodes={api.tree} api={api} /> : null}
    </View>
  );
}

function TaskList({ nodes, api }: { nodes: TaskTreeNode[]; api: WorkTreeApi }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.list}>
      {nodes.map((node) => (
        <TaskLine key={node.workId} node={node} api={api} />
      ))}
    </View>
  );
}

function TaskLine({ node, api }: { node: TaskTreeNode; api: WorkTreeApi }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const tokens = useMobileTokens();
  const colorScheme = useResolvedAppearance();
  const [resultOpen, setResultOpen] = useState(false);
  const state = taskLineState(node);
  const name = node.executor.name || t("Specialist");
  const resultText = node.result?.text ?? null;

  function showMenu() {
    const run: Record<TaskMenuAction, () => void> = {
      cancel: () => api.cancel(node),
      close: () => api.close(node),
      thread: () => api.viewThread(node),
    };
    presentMessageActionSheet({
      title: name,
      actions: taskMenuActions(node).map((action) => ({
        text: taskMenuLabel(action),
        destructive: action === "cancel",
        onPress: run[action],
      })),
      colorScheme,
      cancel: t("Dismiss"),
      more: t("More"),
    });
  }

  return (
    <View style={styles.line}>
      <View style={styles.head}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.mark}
        >
          <NativeSymbol
            {...workStateGlyph(state)}
            size={sizes.receipt}
            color={workStateColor(state, tokens)}
          />
        </View>
        <Text numberOfLines={1} style={[styles.name, state === "closed" && styles.nameClosed]}>
          {name}
        </Text>
        <Text style={styles.meta}>{workStateLabel(state)}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("Actions for {name}", { name })}
          hitSlop={10}
          onPress={showMenu}
        >
          <NativeSymbol
            ios="ellipsis"
            android="ellipsis-horizontal"
            size={sizes.row}
            color={tokens.mutedForeground}
          />
        </Pressable>
      </View>
      <View style={styles.details}>
        <Text style={styles.meta}>{engineLine(node)}</Text>
        {resultText ? (
          <View style={styles.result}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("Result")}
              accessibilityState={{ expanded: resultOpen }}
              hitSlop={10}
              onPress={() => setResultOpen(!resultOpen)}
              style={styles.disclosure}
            >
              <NativeSymbol
                ios={resultOpen ? "chevron.down" : "chevron.right"}
                android={resultOpen ? "chevron-down-outline" : "chevron-forward-outline"}
                size={sizes.receipt}
                color={tokens.mutedForeground}
              />
              <Text style={styles.meta}>{t("Result")}</Text>
            </Pressable>
            {resultOpen ? (
              <ChatMarkdown allowImages={false} palette={tokens} colorScheme={colorScheme}>
                {truncateMarkdownForRender(resultText)}
              </ChatMarkdown>
            ) : null}
          </View>
        ) : null}
        {node.approvals.map((approval) => (
          <Text
            key={approval.effectId}
            style={[styles.meta, approval.status === "pending" && styles.pendingApproval]}
          >
            {approvalLine(approval, api.ownerName)}
          </Text>
        ))}
      </View>
      {node.children.length > 0 ? (
        <View style={styles.children}>
          <TaskList nodes={node.children} api={api} />
        </View>
      ) : null}
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  const meta = { color: tokens.mutedForeground, ...nativeTextStyle("meta") };
  return StyleSheet.create({
    anchor: { gap: 14 },
    disclosure: { alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4 },
    meta,
    list: { gap: 16 },
    line: { gap: 6 },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    mark: { width: sizes.receipt, alignItems: "center" },
    name: { flex: 1, color: tokens.foreground, ...nativeTextStyle("author") },
    nameClosed: { color: tokens.mutedForeground },
    // Lines up under the name: the mark's column and the gap after it.
    details: { paddingStart: sizes.receipt + 10, gap: 8 },
    result: { gap: 6 },
    pendingApproval: { color: tokens.foreground },
    children: {
      marginTop: 6,
      marginStart: 6,
      paddingStart: 12,
      borderStartWidth: StyleSheet.hairlineWidth,
      borderStartColor: tokens.border,
    },
  });
}
