import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import type { RoutineGroupRun, RoutineRowRole } from "@rakazo/core";
import { isNarrationMessage } from "@rakazo/core";
import type { StackedAvatarItem } from "@rakazo/ui-web";
import {
  BotAvatar,
  Button,
  Interstitial,
  MessageBubble,
  MessageRow,
  StackedAvatars,
  Surface,
  UserBubble,
} from "@rakazo/ui-web";
import { ArrowRight, Check, Clock, Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useState } from "react";
import { AgentSteps } from "../../components/AgentSteps";
import { ArtifactFileCard } from "../../components/ArtifactFileCard";
import { AskCard } from "../../components/AskCard";
import { CollaborationMarker } from "../../components/ai/CollaborationMarker";
import { CloudAgentCard } from "../../components/CloudAgentCard";
import { TaskCard } from "../../components/TaskCard";
import { SkillDraftCard } from "../../components/teach/SkillDraftCard";
import { useDisplayAgentSteps } from "../../lib/agent-steps-pref";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { hasRenderableBlock, isHiddenActivityBlock } from "../../lib/message-blocks";
import { messageProviderLabel } from "../../lib/messaging";
import { FALLBACK_BOT_COLOR } from "./layout";

const USER_TEXT_FOLD_LINES = 20;

/** A long user message folds after 20 lines behind a fade until "Show more" is clicked. */
function UserText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  // ponytail: counts newlines, not wrapped lines; a 20-line max-height hides the rest either way.
  const foldable = text.split("\n").length > USER_TEXT_FOLD_LINES;
  if (!foldable) return <LinkifiedText text={text} />;
  return (
    <>
      <div
        data-testid="message-user-text"
        data-folded={!expanded}
        className={
          expanded
            ? undefined
            : "relative max-h-[calc(20*var(--type-body-leading)*var(--type-body-size))] overflow-hidden"
        }
      >
        <LinkifiedText text={text} />
        {expanded ? null : (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-chat-user to-transparent"
          />
        )}
      </div>
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="mt-1.5 text-meta font-medium text-chat-user-foreground/70 duration-(--duration-hover) ease-quiet hover:text-chat-user-foreground"
      >
        {expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
      </button>
    </>
  );
}

import {
  AppConnectCard,
  ArtifactImage,
  ChartBlockView,
  ChoiceCard,
  McpApprovalCard,
} from "./message-cards";
import type { RoutineHandoff } from "./routine-run-line";
import { RoutineGroupLine, RoutineRunLine } from "./routine-run-line";

export function previewMessageText(message: ThreadMessage): string {
  const text = message.blocks
    .map((block) =>
      block.kind === "text" ||
      block.kind === "channel_message" ||
      block.kind === "bot_message_sent" ||
      block.kind === "bot_message_received"
        ? block.text
        : "",
    )
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return t`Attachment`;
  }
  return t`Message`;
}

export const MessageView = memo(function MessageView({
  artifactTarget,
  chrome,
  canAnswer,
  message,
  inGroup,
  showAuthor,
  showAvatar,
  onAnswer,
  onOpenComputer,
  onOpenBot,
  onOpenPeerMessages,
  speakerName,
  memberName,
  peerBot,
  replyPreview,
  replyToMessageId,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  routineRole,
}: {
  artifactTarget: ArtifactTarget;
  /** How the transcript frames this message — derived once, from the same
   * visible blocks it renders, so this view never re-derives it. */
  chrome: "row" | "aside";
  canAnswer: boolean;
  message: ThreadMessage;
  /** True in a multi-bot (group) thread: a bot row reserves an avatar column
   * and its bubble caps at 88% of the content column. False in a single-bot
   * (mono) thread: no avatar column, no name, and the bubble caps at 82% of
   * the thread — the bot's identity lives in the header instead (D2-a). */
  inGroup: boolean;
  /** Show the author name above this message: the first message of a group
   * (`computeMessageGroups`'s `isFirstOfGroup`). Always false in a mono
   * thread. */
  showAuthor: boolean;
  /** Show the avatar for this message: the last message of a group
   * (`isLastOfGroup`). Always false in a mono thread. */
  showAvatar: boolean;
  onAnswer: (message: ThreadMessage, text: string) => Promise<void>;
  /** Set only on the live "Needs you" card: opens the bot's screen. */
  onOpenComputer?: () => void;
  onOpenBot: (botId: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (
    botId: string,
  ) => { color: string; name?: string; shapeSeed?: number | null; status?: string } | undefined;
  replyPreview?: ThreadMessage;
  replyToMessageId?: string;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  /** How this message's routine run renders once runs are folded (a line, a
   * group, or nothing — drawn by another line). Undefined for every message
   * that isn't a routine run. */
  routineRole?: RoutineRowRole;
}) {
  const { t } = useLingui();
  const isNarration = isNarrationMessage(message);
  const isLive = message.id.startsWith("progress:");
  const showSteps = useDisplayAgentSteps();
  const visibleBlocks = message.blocks.filter((block) => !isHiddenActivityBlock(block, showSteps));
  // Nothing this version can draw (a `connect` or legacy `reasoning` block):
  // stay silent rather than paint an avatar and a name around an empty row.
  const drawsSomething = hasRenderableBlock(message.blocks, showSteps);
  const parentJumpId = replyPreview?.id ?? replyToMessageId;
  const messageContext = parentJumpId ? (
    <button
      type="button"
      data-testid="reply-parent-preview"
      aria-label={t`Jump to replied message`}
      onClick={() => onJumpToMessage?.(parentJumpId)}
      className="mb-2 block max-w-3/4 truncate rounded-card border border-border bg-background px-3 py-2 text-start text-meta text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground"
      dir="auto"
    >
      {replyPreview ? previewMessageText(replyPreview) : t`Earlier message`}
    </button>
  ) : null;
  const author = peerBot(message.botId ?? "");
  const avatarOf = (botId: string): StackedAvatarItem => {
    const bot = peerBot(botId);
    return {
      color: bot?.color ?? FALLBACK_BOT_COLOR,
      identity: botId,
      shapeSeed: bot?.shapeSeed,
    };
  };
  /** A bot speaking: a shared name/avatar per group in a multi-bot thread
   * (none at all in mono — D2-a puts the bot's identity in the header
   * instead), then the bubble or card the thread does not otherwise frame. */
  const botRow = (children: ReactNode) => (
    <MessageRow
      avatar={
        <BotAvatar
          color={author?.color ?? FALLBACK_BOT_COLOR}
          identity={message.botId}
          shapeSeed={author?.shapeSeed}
          size={26}
        />
      }
      author={<span dir="auto">{speakerName ?? author?.name ?? t`Bot`}</span>}
      hasAvatarColumn={inGroup}
      showAuthor={showAuthor}
      showAvatar={showAvatar}
    >
      {children}
    </MessageRow>
  );
  if (!drawsSomething) return null;
  if (isNarration) {
    const prose = visibleBlocks.filter((block) => block.kind !== "steps");
    return botRow(
      <>
        {messageContext}
        {visibleBlocks.map((block, i) =>
          block.kind === "steps" ? <AgentSteps key={i} block={block} live={isLive} /> : null,
        )}
        {prose.length > 0 ? (
          <MessageBubble
            data-testid="message-bot-bubble"
            inGroup={inGroup}
            className="space-y-2.5"
            dir="auto"
          >
            {prose.map((block, i) =>
              block.kind === "text" || block.kind === "progress" ? (
                <div key={i}>
                  <ChatMarkdown streaming={block.kind === "progress"}>{block.text}</ChatMarkdown>
                </div>
              ) : null,
            )}
          </MessageBubble>
        ) : null}
      </>,
    );
  }
  const rendered = message.blocks
    .map((block, i) => {
      if (isHiddenActivityBlock(block, showSteps)) return null;
      if (block.kind === "steps") return <AgentSteps key={i} block={block} live={isLive} />;
      if (block.kind === "handoff") {
        const from = memberName?.(block.fromBotId) ?? t`bot`;
        const to = memberName?.(block.toBotId) ?? t`bot`;
        return (
          <div key={i} className="flex flex-col">
            <Interstitial
              avatars={
                <StackedAvatars
                  items={[avatarOf(block.fromBotId), avatarOf(block.toBotId)]}
                  size={17}
                />
              }
            >
              <Trans>
                {from} handed the thread to {to}
              </Trans>{" "}
              {block.text}
            </Interstitial>
          </div>
        );
      }
      if (block.kind === "bot_message_sent" || block.kind === "bot_message_received") {
        const sent = block.kind === "bot_message_sent";
        const peer = sent ? block.toBotName : block.fromBotName;
        const peerBotId = sent ? block.toBotId : block.fromBotId;
        const label = sent ? t`Messaged ${peer}` : t`Message from ${peer}`;
        const self = message.botId;
        const pair = sent ? [self, peerBotId] : [peerBotId, self];
        return (
          <CollaborationMarker
            key={i}
            ariaLabel={label}
            bots={pair.filter((botId): botId is string => Boolean(botId)).map(avatarOf)}
            label={label}
            onClick={() => onOpenPeerMessages({ peerBotId, peerBotName: peer })}
          />
        );
      }
      if (block.kind === "channel_message") {
        return (
          <div
            key={i}
            className="flex items-center justify-center gap-2 py-1 text-meta text-muted-foreground"
          >
            <span>
              {messageProviderLabel(block.provider, block.transport)} · {block.fromLabel}:{" "}
              {block.text}
            </span>
          </div>
        );
      }
      if (block.kind === "meta") {
        return (
          <div
            key={i}
            className="flex items-center justify-center gap-2 py-1 text-meta text-muted-foreground"
          >
            <Clock className="size-3.5 text-warning" strokeWidth={1.8} aria-hidden />
            <span>{block.text}</span>
          </div>
        );
      }
      if (block.kind === "progress") {
        return (
          <MessageBubble key={i} data-testid="message-bot-bubble" inGroup={inGroup} dir="auto">
            <ChatMarkdown streaming>{block.text}</ChatMarkdown>
          </MessageBubble>
        );
      }
      if (block.kind === "subagent") {
        const running = block.status === "running";
        const failed = block.status === "failed";
        return (
          <TaskCard
            key={i}
            title={block.name || t`subagent`}
            state={running ? "running" : failed ? "failed" : "done"}
            meta={block.task}
            body={block.result || block.progress}
            streaming={running}
          />
        );
      }
      if (block.kind === "child_bot") {
        const removed = block.status === "deleted" || block.status === "archived";
        return (
          <Surface key={i} className="w-[min(340px,90%)] overflow-hidden">
            <button
              type="button"
              disabled={removed}
              onClick={() => onOpenBot(block.botId)}
              className="block w-full px-4.5 py-4 text-start disabled:opacity-60"
            >
              <div className="flex items-center justify-between">
                <span className="text-author font-medium text-foreground" dir="auto">
                  {block.name}
                </span>
                <span
                  className={`rounded-full px-3 py-1 text-meta ${
                    removed ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success"
                  }`}
                >
                  {block.status === "archived" ? (
                    <Trans>archived</Trans>
                  ) : block.status === "deleted" ? (
                    <Trans>deleted</Trans>
                  ) : (
                    <Trans>bot</Trans>
                  )}
                </span>
              </div>
              <div className="mt-2 text-meta text-muted-foreground" dir="auto">
                {removed
                  ? block.status === "archived"
                    ? t`Archived. Chat, memory, and files kept.`
                    : t`Removed with chat, computer, and memory.`
                  : block.title || t`Opened its thread.`}
              </div>
            </button>
          </Surface>
        );
      }
      if (block.kind === "routine_run") {
        const handoffFor = (run: RoutineGroupRun): RoutineHandoff | undefined => {
          const sent = run.sentTo;
          if (!sent) return undefined;
          return {
            receipt: <BotAvatar {...avatarOf(sent.toBotId)} size={14} />,
            bots: [avatarOf(message.botId ?? ""), avatarOf(sent.toBotId)],
            label: t`Messaged ${sent.toBotName}`,
            onClick: () =>
              onOpenPeerMessages({ peerBotId: sent.toBotId, peerBotName: sent.toBotName }),
          };
        };
        if (routineRole?.kind === "group") {
          return <RoutineGroupLine key={i} runs={routineRole.runs} handoffFor={handoffFor} />;
        }
        const run: RoutineGroupRun =
          routineRole?.kind === "run"
            ? routineRole.run
            : { messageId: message.id, createdAt: message.createdAt, run: block, latest: true };
        return <RoutineRunLine key={i} item={run} handoff={handoffFor(run)} />;
      }
      if (block.kind === "choice") {
        const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
        if (!botId) return null;
        return <ChoiceCard key={i} botId={botId} block={block} onBotChanged={onBotChanged} />;
      }
      if (block.kind === "app_connect") {
        const botId = "botId" in artifactTarget ? artifactTarget.botId : message.botId;
        if (!botId) return null;
        return (
          <div key={i} className="flex justify-start py-1">
            <AppConnectCard botId={botId} block={block} />
          </div>
        );
      }
      if (block.kind === "chart") {
        return (
          <div key={i} className="flex justify-start">
            <ChartBlockView name={block.name} spec={block.spec} data={block.data} />
          </div>
        );
      }
      if (block.kind === "mcp_approval") {
        return (
          <div key={i} className="flex justify-start">
            <McpApprovalCard
              botId={"botId" in artifactTarget ? artifactTarget.botId : message.botId}
              name={block.name}
              serverId={block.serverId}
              transport={block.transport}
              endpoint={block.endpoint}
              needsOAuth={block.needsOAuth}
            />
          </div>
        );
      }
      if (block.kind === "image") {
        return (
          <div
            key={i}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <ArtifactImage
              target={artifactTarget}
              artifactId={block.artifactId}
              name={block.name}
            />
          </div>
        );
      }
      if (block.kind === "file") {
        return (
          <div
            key={i}
            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <ArtifactFileCard
              target={artifactTarget}
              artifactId={block.artifactId}
              name={block.name}
              mimeType={block.mimeType}
              size={block.size}
            />
          </div>
        );
      }
      if (block.kind === "text" && message.role === "user") {
        return (
          <UserBubble
            key={i}
            data-testid="message-user-bubble"
            className="wrap-anywhere"
            dir="auto"
          >
            <UserText text={block.text} />
          </UserBubble>
        );
      }
      if (block.kind === "text") {
        return (
          <MessageBubble key={i} data-testid="message-bot-bubble" inGroup={inGroup} dir="auto">
            <ChatMarkdown>{block.text}</ChatMarkdown>
          </MessageBubble>
        );
      }
      if (block.kind === "card") {
        return (
          <div key={i} className="flex justify-start">
            <Surface className="flex flex-col gap-2 px-5 py-4">
              {block.lines.map((line) => (
                <div key={line.k} className="flex items-baseline gap-2.5 text-meta">
                  <Check className="size-3.5 text-success" strokeWidth={2} aria-hidden />
                  <span className="font-semibold text-foreground">{line.k}</span>
                  <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden />
                  <span>{line.v}</span>
                </div>
              ))}
            </Surface>
          </div>
        );
      }
      if (block.kind === "ask") {
        return (
          <AskCard
            key={i}
            block={block}
            canAnswer={canAnswer}
            onAnswer={(text) => onAnswer(message, text)}
            messageId={message.id}
          />
        );
      }
      if (block.kind === "cloud_agent") return <CloudAgentCard key={i} block={block} />;
      if (block.kind === "skill_draft") {
        return (
          <div key={i} className="flex justify-start">
            <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
          </div>
        );
      }
      if (block.kind === "computer") {
        return (
          <Surface key={i} className="w-[340px] px-4.5 py-4">
            <div className="flex items-center justify-between">
              <span className="text-author font-medium text-foreground">
                <Trans>Computer</Trans>
              </span>
              <span
                className={
                  block.state === "Needs you"
                    ? "rounded-full bg-warning/15 px-3 py-1 text-meta text-warning"
                    : "rounded-full bg-success/15 px-3 py-1 text-meta text-success"
                }
              >
                {block.state}
              </span>
            </div>
            <div className="my-2.5 text-meta text-muted-foreground">
              <ChatMarkdown>{block.text}</ChatMarkdown>
            </div>
            {onOpenComputer && block.state === "Needs you" ? (
              <Button
                variant="capsule"
                size="capsule"
                data-testid="takeover-open-computer"
                onClick={onOpenComputer}
              >
                <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
                <Trans>Open</Trans>
              </Button>
            ) : null}
          </Surface>
        );
      }
      return null;
    })
    .filter((node) => node !== null);
  // Belt to hasRenderableBlock's braces: a kind added later with no renderer
  // here still must not produce a row with nothing in it.
  if (rendered.length === 0) return null;
  // A reply preview belongs to a row: an aside is a note between messages,
  // and its own link already says where it comes from.
  const body = (
    <>
      {chrome === "row" ? messageContext : null}
      {rendered}
    </>
  );
  // An aside — a handoff, a peer receipt, a channel note — is a line between
  // messages, not something a bot said, so it keeps no author and no bubble.
  // A bot's question or approval is a normal row too: its FramedBlock card
  // (with no header, or a name-less "Needs your call") is just the row's body.
  // Only a bot wears the avatar-and-name row; a user's own message is its
  // right-aligned bubble alone, never wrapped in an author header.
  return chrome === "row" && message.role === "bot" ? botRow(body) : body;
});
