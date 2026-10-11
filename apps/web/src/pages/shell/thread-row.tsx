import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ThreadItem } from "@rakazo/contracts";
import type { RoutineLineRun, SkillSourceBlock, ThreadRow, WaitingCard } from "@rakazo/core";
import { isAsideOnlyMessage, threadTimeMarkerLabel } from "@rakazo/core";
import type { StackedAvatarItem } from "@rakazo/ui-web";
import {
  BotAvatar,
  formatShortDuration,
  Interstitial,
  MessageMeta,
  MessageRow,
  ReasoningDisclosure,
  Separator,
  StackedAvatars,
} from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useState } from "react";
import type { SpawnBotCardEdits } from "../../components/AskCard";
import { AskCard } from "../../components/AskCard";
import { CollaborationMarker } from "../../components/ai/CollaborationMarker";
import { TaskCard } from "../../components/TaskCard";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { hasRenderableBlock, isHiddenActivityBlock } from "../../lib/message-blocks";
import type {
  CardAnswerTarget,
  ItemOf,
  MessageItem,
  SessionViewTarget,
} from "../../lib/thread-items";
import { FALLBACK_BOT_COLOR, threadJumpLocation } from "./layout";
import { MessageView, skillLine } from "./message-view";
import type { RoutineHandoff } from "./routine-run-line";
import { RoutineGroupLine, RoutineRunLine } from "./routine-run-line";

type PeerBot = (
  botId: string,
) => { color: string; name?: string; shapeSeed?: number | null; status?: string } | undefined;

export type RowContext = {
  artifactTarget: ArtifactTarget;
  inGroup: boolean;
  viewerUserId?: string;
  waiting: WaitingCard | null;
  activeRunIds: ReadonlySet<string>;
  onAnswer?: (target: CardAnswerTarget, text: string, edits?: SpawnBotCardEdits) => Promise<void>;
  memberName?: (botId: string | undefined) => string | undefined;
  peerBot: PeerBot;
  onOpenBot: (botId: string, messageId?: string) => void;
  onOpenPeerMessages: (peer: { peerBotId: string; peerBotName: string }) => void;
  onOpenSession: (target: SessionViewTarget) => void;
  onJumpToMessage?: (messageId: string) => void;
  onRefresh: () => Promise<void>;
  onBotChanged: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
  onOpenSkill?: (skill: SkillSourceBlock) => void;
  messageOfEntry: (entryId: string) => MessageItem | undefined;
};

const SHOWN_NOTES = new Set<ItemOf<"note">["type"]>(["skill.learnt", "system.note"]);

export function drawsNothing(item: ThreadItem, showSteps: boolean): boolean {
  if (item.kind === "message") return !hasRenderableBlock(item.blocks, showSteps);
  if (item.kind === "note") return !SHOWN_NOTES.has(item.type);
  return false;
}

export function rowChrome(item: ThreadItem, showSteps: boolean): "row" | "aside" {
  if (item.kind === "message") {
    const blocks = item.blocks.filter((block) => !isHiddenActivityBlock(block, showSteps));
    return isAsideOnlyMessage(blocks) ? "aside" : "row";
  }
  return item.kind === "handoff" ||
    item.kind === "botMessage" ||
    item.kind === "divider" ||
    item.kind === "note"
    ? "aside"
    : "row";
}

export function RowMarker({ marker }: { marker: NonNullable<ThreadRow["marker"]> }) {
  const { t } = useLingui();
  return (
    <time
      dateTime={marker.at}
      className="self-center text-label tabular-nums text-muted-foreground"
    >
      {threadTimeMarkerLabel(marker.at, {
        locale: i18n.locale || "en",
        today: t`Today`,
        yesterday: t`Yesterday`,
        withTime: marker.withTime,
      })}
    </time>
  );
}

export function ThreadRowBody({
  row,
  context,
  chrome,
  showAuthor,
  showAvatar,
  arrivesLive,
}: {
  row: ThreadRow;
  context: RowContext;
  chrome: "row" | "aside";
  showAuthor: boolean;
  showAvatar: boolean;
  arrivesLive: boolean;
}) {
  const { item } = row;
  const body = itemBody(item, row, context, { chrome, showAuthor, showAvatar, arrivesLive });
  const origin =
    "origin" in item && item.origin && !("entryId" in item.origin) ? item.origin : null;
  if (!origin) return body;
  return (
    <>
      <OriginLabel origin={origin} onOpenSession={context.onOpenSession} />
      {body}
    </>
  );
}

function itemBody(
  item: ThreadItem,
  row: ThreadRow,
  context: RowContext,
  frame: {
    chrome: "row" | "aside";
    showAuthor: boolean;
    showAvatar: boolean;
    arrivesLive: boolean;
  },
): ReactNode {
  switch (item.kind) {
    case "message":
      return <MessageRowView item={item} context={context} {...frame} />;
    case "run":
      return (
        <BotSide inGroup={context.inGroup}>
          <RunCard
            item={item}
            live={
              context.waiting?.runId === item.runId
                ? "waiting"
                : context.activeRunIds.has(item.runId)
                  ? "running"
                  : undefined
            }
          />
        </BotSide>
      );
    case "subagent":
      return (
        <BotSide inGroup={context.inGroup}>
          <SubagentCard item={item} onOpenSession={context.onOpenSession} />
        </BotSide>
      );
    case "routine":
      return row.routine ? (
        <BotSide inGroup={context.inGroup}>
          <RoutineRow role={row.routine} context={context} />
        </BotSide>
      ) : null;
    case "handoff":
      return <HandoffLine item={item} context={context} />;
    case "botMessage":
      return <BotMessageMarker item={item} context={context} />;
    case "divider":
      return <DividerLine reason={item.reason} />;
    case "effect":
      return (
        <BotSide inGroup={context.inGroup}>
          <EffectCard item={item} context={context} />
        </BotSide>
      );
    case "note":
      return <NoteLine item={item} onOpenSkill={context.onOpenSkill} />;
  }
}

function MessageRowView({
  item,
  context,
  chrome,
  showAuthor,
  showAvatar,
  arrivesLive,
}: {
  item: MessageItem;
  context: RowContext;
  chrome: "row" | "aside";
  showAuthor: boolean;
  showAvatar: boolean;
  arrivesLive: boolean;
}) {
  const { waiting, onAnswer } = context;
  const replyTo = item.role === "user" ? item.replyTo?.entryId : undefined;
  return (
    <MessageView
      artifactTarget={context.artifactTarget}
      chrome={chrome}
      message={item}
      inGroup={context.inGroup}
      showAuthor={context.inGroup && showAuthor}
      showAvatar={context.inGroup && showAvatar}
      viewerUserId={context.viewerUserId}
      onAnswer={
        waiting && onAnswer && waiting.itemId === item.id
          ? (text, edits) =>
              onAnswer({ runId: waiting.runId, messageId: waiting.entryId }, text, edits)
          : undefined
      }
      onOpenBot={context.onOpenBot}
      onOpenPeerMessages={context.onOpenPeerMessages}
      speakerName={
        chrome !== "row" || item.role !== "bot" ? undefined : context.memberName?.(item.botId)
      }
      memberName={context.memberName}
      peerBot={context.peerBot}
      replyPreview={replyTo ? context.messageOfEntry(replyTo) : undefined}
      replyToMessageId={replyTo}
      onJumpToMessage={context.onJumpToMessage}
      onRefresh={context.onRefresh}
      onBotChanged={context.onBotChanged}
      onAddRoutine={context.onAddRoutine}
      onOpenSkill={context.onOpenSkill}
      arrivesLive={arrivesLive}
    />
  );
}

function BotSide({ inGroup, children }: { inGroup: boolean; children: ReactNode }) {
  return (
    <MessageRow
      avatar={null}
      author={null}
      hasAvatarColumn={inGroup}
      showAuthor={false}
      showAvatar={false}
    >
      {children}
    </MessageRow>
  );
}

function RunCard({ item, live }: { item: ItemOf<"run">; live?: "waiting" | "running" }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const status = item.finished?.outcome.status ?? live;
  const statusLabel =
    status === "waiting"
      ? t`Needs input`
      : status === "running"
        ? t`Running`
        : status === "completed"
          ? t`Completed`
          : status === "failed"
            ? t`Failed`
            : status === "cancelled"
              ? t`Cancelled`
              : undefined;
  const trigger =
    item.trigger.kind === "routine"
      ? item.trigger.name
      : item.trigger.kind === "webhook"
        ? t`Webhook`
        : item.trigger.kind === "retry"
          ? t`Retry`
          : undefined;
  const summary = [trigger, item.model.id, statusLabel].filter(Boolean).join(" · ");
  if (!item.finished) {
    return (
      <p data-testid="run-card" className="text-reasoning text-muted-foreground" dir="auto">
        {summary}
      </p>
    );
  }
  const { usage } = item.finished.outcome;
  const input = usage.inputTokens.toLocaleString(i18n.locale || "en");
  const output = usage.outputTokens.toLocaleString(i18n.locale || "en");
  return (
    <ReasoningDisclosure
      summary={<span dir="auto">{summary}</span>}
      open={open}
      onToggle={() => setOpen(!open)}
      toggleProps={{ "data-testid": "run-card" }}
    >
      <span key="usage" className="font-mono tabular-nums">
        {t`${input} tokens in · ${output} out`}
      </span>
      <span key="duration" className="font-mono tabular-nums">
        {formatShortDuration(item.finished.durationMs)}
      </span>
    </ReasoningDisclosure>
  );
}

function SubagentCard({
  item,
  onOpenSession,
}: {
  item: ItemOf<"subagent">;
  onOpenSession: (target: SessionViewTarget) => void;
}) {
  const { t } = useLingui();
  const title = item.name || t`subagent`;
  if (item.status === "running") {
    return <TaskCard title={title} state="running" meta={item.task} streaming />;
  }
  return (
    <TaskCard
      title={title}
      state={item.status === "failed" ? "failed" : "done"}
      meta={[item.model.id, item.task].filter(Boolean).join(" · ")}
      body={item.result}
      onOpen={() => onOpenSession({ kind: "session", sessionId: item.sessionId, title })}
    />
  );
}

function RoutineRow({
  role,
  context,
}: {
  role: NonNullable<ThreadRow["routine"]>;
  context: RowContext;
}) {
  const { t } = useLingui();
  const avatarOf = avatarLookup(context.peerBot);
  const handoffFor = (run: RoutineLineRun): RoutineHandoff | undefined => {
    const sent = run.sentTo;
    if (!sent) return undefined;
    const peer = sent.peer.name;
    const peerBotId = sent.peer.kind === "bot" ? sent.peer.botId : undefined;
    return {
      receipt: peerBotId ? <BotAvatar {...avatarOf(peerBotId)} size={14} /> : null,
      bots: [run.item.botId, peerBotId].filter((id): id is string => Boolean(id)).map(avatarOf),
      label: t`Messaged ${peer}`,
      onClick: peerBotId
        ? () => context.onOpenPeerMessages({ peerBotId, peerBotName: peer })
        : undefined,
    };
  };
  const openRun = (run: RoutineLineRun) =>
    context.onOpenSession({ kind: "run", runId: run.item.runId, title: run.item.name });
  if (role.kind === "group") {
    return <RoutineGroupLine runs={role.runs} handoffFor={handoffFor} onOpenRun={openRun} />;
  }
  return (
    <RoutineRunLine
      run={role.run}
      handoff={handoffFor(role.run)}
      onOpen={() => openRun(role.run)}
    />
  );
}

function HandoffLine({ item, context }: { item: ItemOf<"handoff">; context: RowContext }) {
  const { t } = useLingui();
  const avatarOf = avatarLookup(context.peerBot);
  const from = context.memberName?.(item.fromBotId) ?? t`bot`;
  const to = context.memberName?.(item.toBotId) ?? t`bot`;
  return (
    <div className="flex flex-col">
      <Interstitial
        avatars={
          <StackedAvatars items={[avatarOf(item.fromBotId), avatarOf(item.toBotId)]} size={17} />
        }
      >
        <Trans>
          {from} handed the thread to {to}
        </Trans>{" "}
        {item.text}
      </Interstitial>
    </div>
  );
}

function BotMessageMarker({ item, context }: { item: ItemOf<"botMessage">; context: RowContext }) {
  const { t } = useLingui();
  const avatarOf = avatarLookup(context.peerBot);
  const peer = item.peer.name;
  const peerBotId = item.peer.kind === "bot" ? item.peer.botId : undefined;
  const sent = item.direction === "sent";
  const self =
    item.direction === "sent"
      ? item.botId
      : "botId" in context.artifactTarget
        ? context.artifactTarget.botId
        : undefined;
  const intent = {
    request: t`Request`,
    result: t`Result`,
    question: t`Question`,
    status: t`Status`,
    fyi: t`FYI`,
  }[item.intent];
  const label = sent ? t`Messaged ${peer}` : t`Message from ${peer}`;
  const messageId = item.direction === "received" ? item.origin.entryId : undefined;
  const jump = peerBotId ? threadJumpLocation({ botId: peerBotId, messageId }) : null;
  const peerLink =
    jump && peerBotId ? (
      <a
        href={`${jump.pathname}${jump.search ?? ""}`}
        className="relative underline-offset-2 hover:underline"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          context.onOpenBot(peerBotId, messageId);
        }}
      >
        {peer}
      </a>
    ) : (
      peer
    );
  const pair = sent ? [self, peerBotId] : [peerBotId, self];
  return (
    <CollaborationMarker
      ariaLabel={`${label} · ${intent}`}
      bots={pair.filter((botId): botId is string => Boolean(botId)).map(avatarOf)}
      label={
        <>
          <ExchangeLabel sent={sent} peer={peerLink} />
          {` · ${intent}`}
        </>
      }
      muted={item.direction === "sent" && item.answeredBy === null}
      onClick={
        peerBotId ? () => context.onOpenPeerMessages({ peerBotId, peerBotName: peer }) : undefined
      }
    />
  );
}

function ExchangeLabel({ sent, peer }: { sent: boolean; peer: ReactNode }) {
  return sent ? <Trans>Messaged {peer}</Trans> : <Trans>Message from {peer}</Trans>;
}

function DividerLine({ reason }: { reason: ItemOf<"divider">["reason"] }) {
  const { t } = useLingui();
  const label =
    reason === "compaction"
      ? t`Earlier messages summarized`
      : reason === "rewind"
        ? t`Message edited`
        : t`Conversation cleared`;
  return (
    <div data-testid="thread-divider" className="flex items-center gap-3 py-1">
      <Separator className="flex-1" />
      <span className="shrink-0 text-label text-muted-foreground">{label}</span>
      <Separator className="flex-1" />
    </div>
  );
}

function EffectCard({ item, context }: { item: ItemOf<"effect">; context: RowContext }) {
  const { t } = useLingui();
  const { waiting, onAnswer } = context;
  if (!item.card) {
    const decision =
      item.decision === "approved" ? t`Approved` : item.decision === "denied" ? t`Denied` : null;
    return (
      <p className="text-meta text-muted-foreground">
        {[item.effectKind, decision].filter(Boolean).join(" · ")}
      </p>
    );
  }
  const runId = item.runId ?? waiting?.runId;
  const answer =
    waiting?.itemId === item.id && onAnswer && runId
      ? (text: string, edits?: SpawnBotCardEdits) =>
          onAnswer({ runId, messageId: item.id }, text, edits)
      : undefined;
  return (
    <AskCard
      block={item.card}
      canAnswer={Boolean(answer)}
      viewerUserId={context.viewerUserId}
      onAnswer={answer ?? noAnswer}
      messageId={item.id}
      botId={item.botId}
    />
  );
}

function NoteLine({
  item,
  onOpenSkill,
}: {
  item: ItemOf<"note">;
  onOpenSkill?: (skill: SkillSourceBlock) => void;
}) {
  if (item.type === "skill.learnt") {
    const { skillId, name, change } = item.payload;
    return (
      <MessageMeta
        lines={[skillLine({ kind: "skill_source", skillId, name, change }, false, onOpenSkill)]}
        className="px-3.5"
      />
    );
  }
  if (item.type === "system.note") {
    return (
      <p className="py-1 text-center text-meta text-muted-foreground" dir="auto">
        {item.payload.text}
      </p>
    );
  }
  return null;
}

function OriginLabel({
  origin,
  onOpenSession,
}: {
  origin: {
    sessionId: ItemOf<"routine">["sessionId"];
    kind?: "routine" | "subagent";
    name?: string;
  };
  onOpenSession: (target: SessionViewTarget) => void;
}) {
  const { t } = useLingui();
  const title = origin.name ?? (origin.kind === "routine" ? t`Routine` : t`subagent`);
  return (
    <button
      type="button"
      data-testid="item-origin"
      aria-haspopup="dialog"
      onClick={() => onOpenSession({ kind: "session", sessionId: origin.sessionId, title })}
      className="mb-1 ps-3 text-label text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground"
      dir="auto"
    >
      {title}
    </button>
  );
}

function avatarLookup(peerBot: PeerBot) {
  return (botId: string): StackedAvatarItem => {
    const bot = peerBot(botId);
    return { color: bot?.color ?? FALLBACK_BOT_COLOR, identity: botId, shapeSeed: bot?.shapeSeed };
  };
}

async function noAnswer(): Promise<void> {}
