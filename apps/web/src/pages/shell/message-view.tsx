import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown, LinkifiedText } from "@rakazo/chat-ui/web";
import type { LinkPreviewCard as LinkPreviewCardBlock, MessageBlock } from "@rakazo/contracts";
import type { LinkMentionResolver, SkillSourceBlock } from "@rakazo/core";
import {
  isLinkOnlyMessage,
  isNarrationMessage,
  linkMentionsKey,
  linkMentionsOf,
  narrationSegments,
  previewSiteLabel,
  sanitizePreviewTitle,
  skillSourcesOf,
  textWithoutPreviewedLinkLine,
} from "@rakazo/core";
import type { MessageRowMeta, StackedAvatarItem } from "@rakazo/ui-web";
import {
  BotAvatar,
  cn,
  Interstitial,
  LinkPreviewCard,
  MessageBubble,
  MessageMeta,
  MessageRow,
  StackedAvatars,
  Surface,
  UserBubble,
} from "@rakazo/ui-web";
import { ArrowRight, BookOpen, Check, Clock } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useMemo, useRef, useState } from "react";
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
import { FALLBACK_BOT_COLOR } from "./layout";
import { messageLinkPreview } from "./message-actions";

const USER_TEXT_FOLD_LINES = 20;

/** A long user message folds after 20 lines behind a fade until "Show more" is clicked. */
function UserText({ text, mentions }: { text: string; mentions?: LinkMentionResolver<ReactNode> }) {
  const [expanded, setExpanded] = useState(false);
  // ponytail: counts newlines, not wrapped lines; a 20-line max-height hides the rest either way.
  const foldable = text.split("\n").length > USER_TEXT_FOLD_LINES;
  if (!foldable) return <LinkifiedText text={text} mentions={mentions} />;
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
        <LinkifiedText text={text} mentions={mentions} />
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
  LinkMentionIcon,
  LinkPreviewImage,
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
export function LinkPreviewRow({
  card,
  artifactTarget,
  side,
  inGroup,
}: {
  card: LinkPreviewCardBlock;
  artifactTarget: ArtifactTarget;
  side: "user" | "bot";
  inGroup: boolean;
}) {
  const image = card.image;
  return (
    <div className={`mt-1 flex first:mt-0 ${side === "user" ? "justify-end" : "justify-start"}`}>
      <LinkPreviewCard
        // The same width cap as the bubble it stands for, so the side still says who sent it.
        className={side === "user" ? "max-w-39/50" : inGroup ? "max-w-22/25" : "max-w-41/50"}
        href={card.url}
        site={previewSiteLabel(card.url)}
        title={card.title ? sanitizePreviewTitle(card.title) : undefined}
        format={card.format}
        imageRatio={image ? image.width / image.height : undefined}
        image={
          image ? (
            <LinkPreviewImage
              target={artifactTarget}
              artifactId={image.artifactId}
              fit={image.fit}
            />
          ) : undefined
        }
      />
    </div>
  );
}

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

async function noAnswer(): Promise<void> {}
