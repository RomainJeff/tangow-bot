import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { MessageBlock } from "@rakazo/contracts";
import type { LinkMentionResolver, SkillSourceBlock } from "@rakazo/core";
import {
  isLinkOnlyMessage,
  isNarrationMessage,
  linkMentionsKey,
  linkMentionsOf,
  narrationSegments,
  skillSourcesOf,
  textWithoutPreviewedLinkLine,
} from "@rakazo/core";
import type { MessageRowMeta, StackedAvatarItem } from "@rakazo/ui-web";
import {
  BotAvatar,
  cn,
  Interstitial,
  MessageBubble,
  MessageMeta,
  MessageRow,
  StackedAvatars,
  UserBubble,
} from "@rakazo/ui-web";
import { BookOpen, Clock } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useMemo, useRef } from "react";
import "../../components/ai/beautiful-ui.css";
import { AgentSteps } from "../../components/AgentSteps";
import { ArtifactFileCard } from "../../components/ArtifactFileCard";
import type { SpawnBotCardEdits } from "../../components/AskCard";
import { AskCard } from "../../components/AskCard";
import { SkillDraftCard } from "../../components/teach/SkillDraftCard";
import { useDisplayAgentSteps } from "../../lib/agent-steps-pref";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { hasRenderableBlock, isHiddenActivityBlock } from "../../lib/message-blocks";
import { messageProviderLabel } from "../../lib/messaging";
import type { MessageItem } from "../../lib/thread-items";
import { botIdOf } from "../../lib/thread-items";
import {
  ChildBotCard,
  ComputerCard,
  LinkPreviewRow,
  ResultLinesCard,
  UserText,
} from "./block-views";
import { FALLBACK_BOT_COLOR } from "./layout";
import { messageLinkPreview } from "./message-actions";

import {
  AppConnectCard,
  ArtifactImage,
  ChartBlockView,
  ChoiceCard,
  LinkMentionIcon,
  McpApprovalCard,
} from "./message-cards";

/**
 * The mentions a message's links render as. The projection rebuilds the message on every event:
 * keyed on its mentions' content, the resolver stays the same object and the memoized markdown it
 * feeds does not re-parse.
 */
export function useLinkMentions(
  message: { role: string; blocks: readonly MessageBlock[] },
  artifactTarget: ArtifactTarget,
): LinkMentionResolver<ReactNode> | undefined {
  const mentionsKey = linkMentionsKey(message);
  return useMemo<LinkMentionResolver<ReactNode> | undefined>(() => {
    const lookup = linkMentionsOf(message);
    return (
      lookup && {
        ...lookup,
        icon: (artifactId) => <LinkMentionIcon target={artifactTarget} artifactId={artifactId} />,
      }
    );
  }, [mentionsKey, artifactTarget]);
}

/** A preview card under the bubble it stands for, aligned to its edge and capped to its width. */
export function previewMessageText(message: { blocks: readonly MessageBlock[] }): string {
  const text = message.blocks
    .map((block) => (block.kind === "text" || block.kind === "channel_message" ? block.text : ""))
    .filter(Boolean)
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return t`Attachment`;
  }
  return t`Message`;
}

export function skillLine(
  skill: SkillSourceBlock,
  live: boolean,
  onOpenSkill?: (skill: SkillSourceBlock) => void,
): MessageRowMeta {
  const { name } = skill;
  return {
    label:
      skill.change === "learned"
        ? t`Skill learned · ${name}`
        : skill.change === "updated"
          ? t`Skill updated · ${name}`
          : t`Skill deleted · ${name}`,
    icon: <BookOpen aria-hidden className={cn("size-3.5 shrink-0", live && "bui-skill-icon")} />,
    className: live ? "bui-skill-line" : undefined,
    ...(onOpenSkill && skill.change !== "deleted" ? { onClick: () => onOpenSkill(skill) } : {}),
  };
}

export const MessageView = memo(function MessageView({
  artifactTarget,
  chrome,
  viewerUserId,
  message,
  inGroup,
  showAuthor,
  showAvatar,
  onAnswer,
  onOpenBot,
  speakerName,
  memberName,
  peerBot,
  replyPreview,
  replyToMessageId,
  onJumpToMessage,
  onRefresh,
  onBotChanged,
  onAddRoutine,
  onOpenSkill,
  arrivesLive = false,
}: {
  artifactTarget: ArtifactTarget;
  /** How the transcript frames this message — derived once, from the same
   * visible blocks it renders, so this view never re-derives it. */
  chrome: "row" | "aside";
  viewerUserId?: string;
  message: MessageItem;
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
  onAnswer?: (text: string, edits?: SpawnBotCardEdits) => Promise<void>;
  onOpenBot: (botId: string) => void;
  speakerName?: string;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: (
    botId: string,
  ) => { color: string; name?: string; shapeSeed?: number | null; status?: string } | undefined;
  replyPreview?: MessageItem;
  replyToMessageId?: string;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  /** Opens a skill from the line a bot's message carries; absent in a group, which has no bot page. */
  onOpenSkill?: (skill: SkillSourceBlock) => void;
  /** This message is new activity, not history: its skill line arrives with a beat. */
  arrivesLive?: boolean;
}) {
  const { t } = useLingui();
  const skills = skillSourcesOf(message.blocks);
  const skillsAtMount = useRef(skills.length);
  const skillLinesLive = arrivesLive || skills.length > skillsAtMount.current;
  const mentions = useLinkMentions(message, artifactTarget);
  const isNarration = isNarrationMessage(message);
  const botId = botIdOf(message);
  const isLive = message.role === "bot" && message.live === true;
  const showSteps = useDisplayAgentSteps();
  const narrationBlocks = message.blocks.filter(
    (block) => block.kind === "steps" || !isHiddenActivityBlock(block, showSteps),
  );
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
  const author = peerBot(botId ?? "");
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
          identity={botId}
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
  // A message that is only its link: the card takes the bubble's place (and the bubble comes
  // back if the preview is removed, since the text is stored as sent).
  const previewCard = messageLinkPreview(message);
  const texts = message.blocks.filter((block) => block.kind === "text");
  const linkOnly =
    previewCard !== undefined &&
    texts.length === 1 &&
    texts[0]?.kind === "text" &&
    isLinkOnlyMessage(texts[0].text, previewCard.url);
  /**
   * What the bubble shows of a text: without the line that is only the previewed link, which the
   * card already shows. The stored text, Copy, search and the model keep it. Undefined when that
   * line was all there was.
   */
  const bubbleText = (text: string): string | undefined => {
    if (!previewCard || linkOnly) return text;
    const shown = textWithoutPreviewedLinkLine(text, previewCard.url);
    return shown || shown === text ? shown : undefined;
  };
  const previewView = (key?: number) =>
    previewCard ? (
      <LinkPreviewRow
        key={key}
        card={previewCard}
        artifactTarget={artifactTarget}
        side={message.role === "user" ? "user" : "bot"}
        inGroup={inGroup}
      />
    ) : null;
  const skillLines = skills.map((skill) => skillLine(skill, skillLinesLive, onOpenSkill));
  if (!drawsSomething) return null;
  if (isNarration) {
    const parts = narrationSegments(
      narrationBlocks,
      (block) => {
        const text =
          block.kind === "progress"
            ? block.text
            : block.kind === "text" && !linkOnly
              ? bubbleText(block.text)
              : undefined;
        return text === undefined ? undefined : { text, streaming: block.kind === "progress" };
      },
      showSteps,
    );
    const lastBubble = parts.findLastIndex((part) => part.kind === "content");
    return botRow(
      <>
        {messageContext}
        {parts.map((part, i) =>
          part.kind === "steps" ? (
            <AgentSteps key={i} block={part.block} live={isLive} />
          ) : (
            <MessageBubble
              key={i}
              data-testid="message-bot-bubble"
              inGroup={inGroup}
              className="space-y-2.5"
              dir="auto"
              meta={i === lastBubble && skillLines.length > 0 ? skillLines : undefined}
            >
              {part.blocks.map((entry, j) => (
                <div key={j}>
                  <ChatMarkdown streaming={entry.streaming} mentions={mentions}>
                    {entry.text}
                  </ChatMarkdown>
                </div>
              ))}
            </MessageBubble>
          ),
        )}
        {previewView()}
        {lastBubble < 0 && skillLines.length > 0 ? (
          <MessageMeta lines={skillLines} className="px-3.5" />
        ) : null}
      </>,
    );
  }
  // The lines hang under the last bubble the message draws; with no bubble they stand alone.
  const skillLineBubble =
    message.role === "bot" && !linkOnly
      ? message.blocks.findLastIndex(
          (block) => block.kind === "text" && bubbleText(block.text) !== undefined,
        )
      : -1;
  const firstSkillBlock = message.blocks.findIndex((block) => block.kind === "skill_source");
  const rendered = message.blocks
    .map((block, i) => {
      if (isHiddenActivityBlock(block, showSteps)) return null;
      if (block.kind === "link_preview") return block === previewCard ? previewView(i) : null;
      if (linkOnly && block.kind === "text") return null;
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
      if (block.kind === "child_bot") {
        return <ChildBotCard key={i} block={block} onOpenBot={onOpenBot} />;
      }
      if (block.kind === "skill_source") {
        return skillLineBubble < 0 && i === firstSkillBlock ? (
          <MessageMeta key={i} lines={skillLines} className="px-3.5" />
        ) : null;
      }
      if (block.kind === "choice") {
        const cardBotId = "botId" in artifactTarget ? artifactTarget.botId : botId;
        if (!cardBotId) return null;
        return <ChoiceCard key={i} botId={cardBotId} block={block} onBotChanged={onBotChanged} />;
      }
      if (block.kind === "app_connect") {
        const cardBotId = "botId" in artifactTarget ? artifactTarget.botId : botId;
        if (!cardBotId) return null;
        return (
          <div key={i} className="flex justify-start py-1">
            <AppConnectCard botId={cardBotId} block={block} />
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
              botId={"botId" in artifactTarget ? artifactTarget.botId : botId}
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
      if (block.kind === "text") {
        const shown = bubbleText(block.text);
        if (shown === undefined) return null;
        if (message.role === "user") {
          return (
            <UserBubble
              key={i}
              data-testid="message-user-bubble"
              className="wrap-anywhere"
              dir="auto"
            >
              <UserText text={shown} mentions={mentions} />
            </UserBubble>
          );
        }
        return (
          <MessageBubble
            key={i}
            data-testid="message-bot-bubble"
            inGroup={inGroup}
            dir="auto"
            meta={i === skillLineBubble && skillLines.length > 0 ? skillLines : undefined}
          >
            <ChatMarkdown mentions={mentions}>{shown}</ChatMarkdown>
          </MessageBubble>
        );
      }
      if (block.kind === "card") {
        return <ResultLinesCard key={i} block={block} />;
      }
      if (block.kind === "ask") {
        return (
          <AskCard
            key={i}
            block={block}
            canAnswer={Boolean(onAnswer)}
            viewerUserId={viewerUserId}
            onAnswer={onAnswer ?? noAnswer}
            messageId={message.id}
            botId={botId}
          />
        );
      }
      if (block.kind === "skill_draft") {
        return (
          <div key={i} className="flex justify-start">
            <SkillDraftCard block={block} onRefresh={onRefresh} onAddRoutine={onAddRoutine} />
          </div>
        );
      }
      if (block.kind === "computer") {
        return <ComputerCard key={i} block={block} />;
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

async function noAnswer(): Promise<void> {}
