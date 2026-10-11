import type {
  SessionEntry,
  SessionEntryOf,
  SessionId,
  ThreadItem,
  UiEntry,
} from "@rakazo/contracts";
import { isUiEntry } from "@rakazo/contracts";
import { childSessionsOf, originSessionIdOf } from "./child-sessions.js";
import { foldRuns } from "./run-fold.js";

type RunItem = Extract<ThreadItem, { kind: "run" }>;
type EffectItem = Extract<ThreadItem, { kind: "effect" }>;
type RoutineItem = Extract<ThreadItem, { kind: "routine" }>;

/**
 * What a thread shows, from a page of a session's chain oldest first. A run becomes one `run`
 * item where it started and one `message` item per unbroken stretch of its words; a routine run,
 * whose words live in its own session, becomes one `routine` item its finish fills in. A run whose
 * start is outside the page gets no `run` item, though its words on the page still show; an
 * effect whose request is outside the page is left out, as is a tool result without its call. An
 * item whose entry rose from a child session names it as `origin`, with the routine's or the
 * helper's name when the page holds its start.
 */
export function projectThreadItems(entries: readonly SessionEntry[]): ThreadItem[] {
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
  const runs = new Map<string, RunItem>();
  const effects = new Map<string, EffectItem>();
  const routines = new Map<string, RoutineItem>();
  const items: ThreadItem[] = [];
  for (const segment of foldRuns(visible)) {
    switch (segment.type) {
      case "run.message": {
        const { id, ts, botId, runId, blocks, originSessionId } = segment;
        items.push({
          kind: "message",
          role: "bot",
          id,
          ts,
          botId,
          runId,
          blocks,
          ...origin(originSessionId),
        });
        break;
      }
      case "bot.text": {
        const { id, ts, botId, payload } = segment;
        items.push({
          kind: "message",
          role: "bot",
          id,
          ts,
          botId,
          blocks: payload.blocks,
          ...origin(payload.originSessionId),
        });
        break;
      }
      case "user.message": {
        const { originSessionId, ...payload } = segment.payload;
        items.push({
          kind: "message",
          role: "user",
          id: segment.id,
          ts: segment.ts,
          ...payload,
          ...origin(originSessionId),
        });
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
        items.push(run);
        break;
      }
      case "run.finished": {
        const run = runs.get(segment.runId);
        if (run) {
          run.finished = {
            outcome: segment.payload,
            durationMs: Math.max(0, Date.parse(segment.ts) - Date.parse(run.ts)),
          };
        }
        break;
      }
      case "subagent":
        items.push({
          kind: "subagent",
          id: segment.id,
          ts: segment.ts,
          runId: segment.runId,
          ...segment.payload,
        });
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
        items.push(routine);
        break;
      }
      case "routine.finished": {
        const routine = routines.get(segment.runId);
        if (routine) {
          routine.finished = { status: segment.payload.status, result: segment.payload.result };
        }
        break;
      }
      case "handoff": {
        const { fromBotId, toBotId, text } = segment.payload;
        items.push({
          kind: "handoff",
          id: segment.id,
          ts: segment.ts,
          fromBotId,
          toBotId,
          text,
          ...origin(segment.payload.originSessionId),
        });
        break;
      }
      case "bot.message.sent": {
        const { to, text, intent, exchangeId } = segment.payload;
        const answer = received.get(exchangeId)?.find((entry) => entry.seq > segment.seq);
        items.push({
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
        });
        break;
      }
      case "bot.message.received": {
        const { from, text, intent, exchangeId, fromSessionId, fromEntryId } = segment.payload;
        items.push({
          kind: "botMessage",
          direction: "received",
          id: segment.id,
          ts: segment.ts,
          peer: from,
          text,
          intent,
          exchangeId,
          origin: { sessionId: fromSessionId, entryId: fromEntryId },
        });
        break;
      }
      case "effect.requested": {
        const { effectId, effectKind, proposal } = segment.payload;
        const effect: EffectItem = {
          kind: "effect",
          id: segment.id,
          ts: segment.ts,
          effectId,
          effectKind,
          proposal,
          decision: null,
          ...origin(segment.payload.originSessionId),
        };
        effects.set(effectId, effect);
        items.push(effect);
        break;
      }
      case "effect.edited": {
        const effect = effects.get(segment.payload.effectId);
        if (effect) effect.proposal = segment.payload.proposal;
        break;
      }
      case "effect.resolved": {
        const effect = effects.get(segment.payload.effectId);
        if (effect) effect.decision = segment.payload.decision;
        break;
      }
      case "compaction":
      case "rewind":
      case "clear":
        items.push({ kind: "divider", id: segment.id, ts: segment.ts, reason: segment.type });
        break;
      case "computer.control":
      case "memory.revised":
      case "skill.saved":
      case "attachment.added":
      case "session.title":
      case "system.note": {
        const { sessionId, seq, parentId, botId, runId, ...note } = segment;
        items.push({ kind: "note", ...note, ...origin(originSessionIdOf(segment)) });
        break;
      }
      default:
        segment satisfies Exclude<SessionEntry, UiEntry>;
    }
  }
  return items;
}
