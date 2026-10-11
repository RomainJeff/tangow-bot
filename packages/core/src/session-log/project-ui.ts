import type {
  EntryId,
  MessageBlock,
  SessionEntry,
  SessionEntryOf,
  SessionId,
  ThreadItem,
  UiEntry,
} from "@rakazo/contracts";
import {
  ASK_DISMISSED_ANSWER,
  appConnectAnswerId,
  CHOICE_DISMISSED_ANSWER_ID,
  isUiEntry,
} from "@rakazo/contracts";
import { childSessionsOf, originSessionIdOf } from "./child-sessions.js";
import { foldRuns, toolOutputs } from "./run-fold.js";

type RunItem = Extract<ThreadItem, { kind: "run" }>;
type EffectItem = Extract<ThreadItem, { kind: "effect" }>;
type RoutineItem = Extract<ThreadItem, { kind: "routine" }>;
type MessageItem = Extract<ThreadItem, { kind: "message" }>;
type SubagentItem = Extract<ThreadItem, { kind: "subagent" }>;
type DividerItem = Extract<ThreadItem, { kind: "divider" }>;
type AskBlock = Extract<MessageBlock, { kind: "ask" }>;

/** Where a card that later entries settle sits: a block of a message, or an approval's card. */
type CardSlot = { item: MessageItem; index: number } | { item: EffectItem };

/** The card the thread waits on: an ask, a choice or an approval with no answer, in a run still open. */
export type WaitingCard = { itemId: EntryId; entryId: EntryId; runId: string };

export type ProjectedThread = {
  items: ThreadItem[];
  /** The id of the item that shows each entry. */
  shownBy: Map<EntryId, EntryId>;
  /** The id message actions name for an item, by item id: the published message it starts with. */
  messageIds: Map<EntryId, EntryId>;
  waiting: WaitingCard | null;
};

const BOT_TEXT_CARD_KINDS = new Set<MessageBlock["kind"]>(["choice", "app_connect", "skill_draft"]);
const MESSAGE_ENTRY_TYPES = new Set<SessionEntry["type"]>([
  "assistant.text",
  "assistant.reasoning",
  "assistant.ask",
  "assistant.choice",
]);

/**
 * What a thread shows, from a page of a session's chain oldest first. See `projectThread`.
 */
export function projectThreadItems(entries: readonly SessionEntry[]): ThreadItem[] {
  return projectThread(entries).items;
}

/**
 * What a thread shows, from a page of a session's chain oldest first. A run becomes one `run`
 * item where it started and one `message` item per unbroken stretch of its words, followed by a
 * running `subagent` item for each helper it launched that has not answered yet; a routine run,
 * whose words live in its own session, becomes one `routine` item its finish fills in. A run whose
 * start is outside the page gets no `run` item, though its words on the page still show; an
 * effect whose request is outside the page is left out, as is a tool result without its call. An
 * item whose entry rose from a child session names it as `origin`, with the routine's or the
 * helper's name when the page holds its start. Entries about an earlier card or message settle
 * that card or add to that message, and a reply that is a card's own answer record shows as the
 * answered card alone. A compaction's divider sits before the first item it did not summarize.
 */
export function projectThread(entries: readonly SessionEntry[]): ProjectedThread {
  const visible = entries.filter(isUiEntry);
  const received = new Map<string, SessionEntryOf<"bot.message.received">[]>();
  for (const entry of visible) {
    if (entry.type !== "bot.message.received") continue;
    received.set(entry.payload.exchangeId, [
      ...(received.get(entry.payload.exchangeId) ?? []),
      entry,
    ]);
  }
  const children = childSessionsOf(visible);
  const origin = (sessionId: SessionId | undefined) =>
    sessionId ? { origin: { sessionId, ...children.get(sessionId) } } : {};
  const outputs = toolOutputs(visible);
  const seqOf = new Map<string, number>(visible.map((entry) => [entry.id, entry.seq]));
  const runs = new Map<string, RunItem>();
  const effects = new Map<string, EffectItem>();
  const routines = new Map<string, RoutineItem>();
  const items: ThreadItem[] = [];
  const itemById = new Map<string, ThreadItem>();
  const shownBy = new Map<EntryId, EntryId>();
  const messageIds = new Map<EntryId, EntryId>();
  const cards = new Map<string, CardSlot[]>();
  const runCards: { id: EntryId; runId: string; seq: number }[] = [];
  const finishedAt = new Map<string, number>();
  const previews = new Map<string, { item: MessageItem; block: MessageBlock }>();
  const compactions = new Map<DividerItem, number>();

  const push = (item: ThreadItem, ...shown: EntryId[]) => {
    items.push(item);
    itemById.set(item.id, item);
    for (const id of shown) shownBy.set(id, item.id);
  };
  const showWith = (entry: SessionEntry, target: string | undefined) => {
    const itemId = target === undefined ? undefined : shownBy.get(target as EntryId);
    if (itemId !== undefined) shownBy.set(entry.id, itemId);
  };
  const itemShowing = (target: string) => {
    const itemId = shownBy.get(target as EntryId);
    return itemId === undefined ? undefined : itemById.get(itemId);
  };

  for (const segment of foldRuns(visible, outputs)) {
    switch (segment.type) {
      case "run.message": {
        const { id, ts, botId, runId, blocks, originSessionId } = segment;
        const message: MessageItem = {
          kind: "message",
          role: "bot",
          id,
          ts,
          botId,
          runId,
          blocks,
          ...origin(originSessionId),
        };
        push(message, ...segment.entries.map((entry) => entry.id));
        const first = segment.entries.find((entry) => MESSAGE_ENTRY_TYPES.has(entry.type));
        if (first) messageIds.set(id, first.id);
        for (const [entryId, index] of segment.cards)
          cards.set(entryId, [{ item: message, index }]);
        for (const entry of segment.entries) {
          if (entry.type === "assistant.ask" || entry.type === "assistant.choice") {
            runCards.push({ id: entry.id, runId: entry.runId, seq: entry.seq });
          }
          if (entry.type === "tool.call" && entry.payload.name === "run_subagent") {
            if (outputs.has(entry.id)) continue;
            const helper: SubagentItem = {
              kind: "subagent",
              status: "running",
              id: `subagent:${entry.id}` as EntryId,
              ts: entry.ts,
              runId: entry.runId,
              callId: entry.payload.callId,
              ...subagentInput(entry.payload.input),
            };
            items.push(helper);
            itemById.set(helper.id, helper);
          }
        }
        break;
      }
      case "bot.text": {
        const { id, ts, botId, payload } = segment;
        const message: MessageItem = {
          kind: "message",
          role: "bot",
          id,
          ts,
          botId,
          blocks: [...payload.blocks],
          ...origin(payload.originSessionId),
        };
        push(message, id);
        messageIds.set(id, id);
        const slots = message.blocks.flatMap((block, index) =>
          BOT_TEXT_CARD_KINDS.has(block.kind) ? [{ item: message, index }] : [],
        );
        if (slots.length > 0) cards.set(id, slots);
        break;
      }
      case "user.message": {
        const { originSessionId, ...payload } = segment.payload;
        const card = payload.replyTo ? questionAt(cards.get(payload.replyTo.entryId)) : undefined;
        if (card) {
          const block = cardOf(card);
          if (block && !isSettled(block)) setCard(card, answerWith(block, textOf(payload.blocks)));
          if (payload.clientNonce === undefined && payload.source === "app") {
            shownBy.set(segment.id, card.item.id);
            break;
          }
        }
        push(
          {
            kind: "message",
            role: "user",
            id: segment.id,
            ts: segment.ts,
            ...payload,
            blocks: [...payload.blocks],
            ...origin(originSessionId),
          },
          segment.id,
        );
        messageIds.set(segment.id, segment.id);
        break;
      }
      case "run.started": {
        const run: RunItem = {
          kind: "run",
          id: segment.id,
          ts: segment.ts,
          runId: segment.runId,
          botId: segment.botId,
          ...segment.payload,
          finished: null,
        };
        runs.set(segment.runId, run);
        push(run, segment.id);
        break;
      }
      case "run.finished": {
        finishedAt.set(segment.runId, segment.seq);
        const run = runs.get(segment.runId);
        if (run) {
          run.finished = {
            outcome: segment.payload,
            durationMs: Math.max(0, Date.parse(segment.ts) - Date.parse(run.ts)),
          };
          shownBy.set(segment.id, run.id);
        }
        break;
      }
      case "subagent":
        push(
          {
            kind: "subagent",
            id: segment.id,
            ts: segment.ts,
            runId: segment.runId,
            ...segment.payload,
          },
          segment.id,
        );
        break;
      case "routine.started": {
        const { sessionId, routineId, name } = segment.payload;
        const routine: RoutineItem = {
          kind: "routine",
          id: segment.id,
          ts: segment.ts,
          runId: segment.runId,
          botId: segment.botId,
          sessionId,
          routineId,
          name,
          finished: null,
        };
        routines.set(segment.runId, routine);
        push(routine, segment.id);
        break;
      }
      case "routine.finished": {
        const routine = routines.get(segment.runId);
        if (routine) {
          routine.finished = { status: segment.payload.status, result: segment.payload.result };
          shownBy.set(segment.id, routine.id);
        }
        break;
      }
      case "handoff": {
        const { fromBotId, toBotId, text } = segment.payload;
        push(
          {
            kind: "handoff",
            id: segment.id,
            ts: segment.ts,
            fromBotId,
            toBotId,
            text,
            ...origin(segment.payload.originSessionId),
          },
          segment.id,
        );
        break;
      }
      case "bot.message.sent": {
        const { to, text, intent, exchangeId } = segment.payload;
        const answer = received.get(exchangeId)?.find((entry) => entry.seq > segment.seq);
        push(
          {
            kind: "botMessage",
            direction: "sent",
            id: segment.id,
            ts: segment.ts,
            botId: segment.botId,
            peer: to,
            text,
            intent,
            exchangeId,
            answeredBy: answer?.id ?? null,
            ...origin(segment.payload.originSessionId),
          },
          segment.id,
        );
        break;
      }
      case "bot.message.received": {
        const { from, text, intent, exchangeId, fromSessionId, fromEntryId } = segment.payload;
        push(
          {
            kind: "botMessage",
            direction: "received",
            id: segment.id,
            ts: segment.ts,
            peer: from,
            text,
            intent,
            exchangeId,
            origin: { sessionId: fromSessionId, entryId: fromEntryId },
          },
          segment.id,
        );
        break;
      }
      case "effect.requested": {
        const { effectId, effectKind, proposal, card } = segment.payload;
        const effect: EffectItem = {
          kind: "effect",
          id: segment.id,
          ts: segment.ts,
          effectId,
          effectKind,
          proposal,
          decision: null,
          ...(segment.botId ? { botId: segment.botId } : {}),
          ...(segment.runId ? { runId: segment.runId } : {}),
          ...(card ? { card } : {}),
          ...origin(segment.payload.originSessionId),
        };
        effects.set(effectId, effect);
        push(effect, segment.id);
        messageIds.set(segment.id, segment.id);
        cards.set(segment.id, [{ item: effect }]);
        if (segment.runId)
          runCards.push({ id: segment.id, runId: segment.runId, seq: segment.seq });
        break;
      }
      case "effect.edited": {
        const effect = effects.get(segment.payload.effectId);
        if (!effect) break;
        effect.proposal = segment.payload.proposal;
        if (segment.payload.card) effect.card = segment.payload.card;
        shownBy.set(segment.id, effect.id);
        break;
      }
      case "effect.resolved": {
        const effect = effects.get(segment.payload.effectId);
        if (!effect) break;
        const { decision, answerId, dismissed } = segment.payload;
        effect.decision = decision;
        if (effect.card) {
          effect.card = {
            ...effect.card,
            status: "answered",
            answer:
              answerId ??
              (dismissed ? ASK_DISMISSED_ANSWER : decision === "approved" ? "allow" : "deny"),
          };
        }
        shownBy.set(segment.id, effect.id);
        break;
      }
      case "effect.applied": {
        const { target, routineId, change, failed } = segment.payload;
        const slot = cards.get(target)?.find((slot) => cardOf(slot)?.kind === "ask");
        const block = slot && cardOf(slot);
        if (slot && block?.kind === "ask") {
          setCard(slot, {
            ...block,
            ...(routineId
              ? { created: { kind: "routine", id: routineId, label: block.routine?.name ?? "" } }
              : {}),
            ...(change ? { confirms: change } : {}),
            ...(failed ? { failed } : {}),
          });
        }
        showWith(segment, target);
        break;
      }
      case "card.answered": {
        const { target, answerId } = segment.payload;
        const slots = cards.get(target) ?? [];
        const question = questionAt(slots.filter((slot) => isOpen(cardOf(slot))));
        const block = question && cardOf(question);
        if (question && block?.kind === "ask") {
          const answer = answerId ?? (block.input === "secret" ? "" : undefined);
          setCard(question, {
            ...block,
            status: "answered",
            ...(answer === undefined ? {} : { answer }),
          });
        } else if (question && block?.kind === "choice") {
          setCard(question, { ...block, answerId: answerId ?? CHOICE_DISMISSED_ANSWER_ID });
        }
        const connects = slots.filter((slot) => cardOf(slot)?.kind === "app_connect");
        for (const slot of connects) {
          const connect = cardOf(slot);
          if (connect?.kind !== "app_connect") continue;
          if (appConnectAnswerId(connect) === answerId) {
            setCard(slot, { ...connect, status: "connected" });
          }
        }
        showWith(segment, target);
        break;
      }
      case "skill.draft": {
        const { target, ...draft } = segment.payload;
        const drafts = (cards.get(target) ?? []).filter(
          (slot) => cardOf(slot)?.kind === "skill_draft",
        );
        const slot =
          drafts.find((slot) => {
            const block = cardOf(slot);
            return block?.kind === "skill_draft" && block.skillId === draft.skillId;
          }) ?? drafts[0];
        if (slot) setCard(slot, { kind: "skill_draft", ...draft });
        showWith(segment, target);
        break;
      }
      case "link.preview": {
        const item = itemShowing(segment.payload.target);
        if (item?.kind !== "message") break;
        const block: MessageBlock = segment.payload.block;
        item.blocks.push(block);
        previews.set(segment.id, { item, block });
        shownBy.set(segment.id, item.id);
        break;
      }
      case "link.preview.removed": {
        const preview = previews.get(segment.payload.target);
        if (!preview) break;
        const index = preview.item.blocks.indexOf(preview.block);
        if (index !== -1) preview.item.blocks.splice(index, 1);
        shownBy.set(segment.id, preview.item.id);
        break;
      }
      case "compaction": {
        const divider: DividerItem = {
          kind: "divider",
          id: segment.id,
          ts: segment.ts,
          reason: "compaction",
        };
        compactions.set(divider, segment.payload.coveredUpToSeq);
        push(divider, segment.id);
        break;
      }
      case "rewind":
      case "clear":
        push({ kind: "divider", id: segment.id, ts: segment.ts, reason: segment.type }, segment.id);
        break;
      case "computer.control":
      case "memory.revised":
      case "skill.learnt":
      case "attachment.added":
      case "session.title":
      case "system.note": {
        const { sessionId, seq, parentId, botId, runId, ...note } = segment;
        push({ kind: "note", ...note, ...origin(originSessionIdOf(segment)) }, segment.id);
        break;
      }
      default:
        segment satisfies Exclude<SessionEntry, UiEntry>;
    }
  }

  for (const [divider, coveredUpToSeq] of compactions) {
    const to = items.findIndex(
      (item) => item !== divider && (seqOf.get(item.id) ?? -1) > coveredUpToSeq,
    );
    const from = items.indexOf(divider);
    if (to === -1 || to > from) continue;
    items.splice(from, 1);
    items.splice(to, 0, divider);
  }

  const open = runCards.filter((card) => {
    const slot = cards.get(card.id)?.[0];
    const settled = !slot || ("index" in slot ? isSettled(cardOf(slot)) : slot.item.decision);
    return !settled && (finishedAt.get(card.runId) ?? -1) < card.seq;
  });
  const last = open.at(-1);
  const itemId = last && shownBy.get(last.id);
  const waiting = last && itemId ? { itemId, entryId: last.id, runId: last.runId } : null;
  return { items, shownBy, messageIds, waiting };
}

function cardOf(slot: CardSlot): MessageBlock | undefined {
  return "index" in slot ? slot.item.blocks[slot.index] : slot.item.card;
}

function setCard(slot: CardSlot, block: MessageBlock) {
  if ("index" in slot) slot.item.blocks[slot.index] = block;
  else if (block.kind === "ask") slot.item.card = block;
}

/** The ask or choice of a message a reply or a settling entry is about: the first still open. */
function questionAt(slots: readonly CardSlot[] | undefined) {
  const questions = (slots ?? []).filter(
    (slot): slot is Extract<CardSlot, { index: number }> =>
      "index" in slot && (cardOf(slot)?.kind === "ask" || cardOf(slot)?.kind === "choice"),
  );
  return questions.find((slot) => isOpen(cardOf(slot))) ?? questions[0];
}

function isOpen(block: MessageBlock | undefined): boolean {
  return (block?.kind === "ask" || block?.kind === "choice") && !isSettled(block);
}

function isSettled(block: MessageBlock | undefined): boolean {
  if (block?.kind === "ask") return block.status === "answered";
  if (block?.kind === "choice") return block.answerId !== undefined;
  return false;
}

function answerWith(block: MessageBlock, reply: string): MessageBlock {
  if (block.kind === "ask")
    return { ...block, status: "answered", answer: reply } satisfies AskBlock;
  if (block.kind === "choice") {
    const chosen = block.options.find((option) => option.label === reply);
    return { ...block, answerId: chosen?.id ?? reply };
  }
  return block;
}

function textOf(blocks: readonly MessageBlock[]): string {
  return blocks.flatMap((block) => (block.kind === "text" ? [block.text] : [])).join("\n");
}

function subagentInput(input: string): { name: string; task: string } {
  try {
    const parsed: unknown = JSON.parse(input);
    const fields = typeof parsed === "object" && parsed !== null ? parsed : {};
    const name = "name" in fields && typeof fields.name === "string" ? fields.name : "";
    const task = "task" in fields && typeof fields.task === "string" ? fields.task : "";
    return { name, task };
  } catch {
    return { name: "", task: "" };
  }
}
