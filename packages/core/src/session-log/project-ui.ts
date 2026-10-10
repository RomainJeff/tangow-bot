import type { SessionEntry, SessionEntryOf, ThreadItem, UiEntry } from "@rakazo/contracts";
import { isUiEntry } from "@rakazo/contracts";
import { foldRuns } from "./run-fold.js";

type RunItem = Extract<ThreadItem, { kind: "run" }>;
type EffectItem = Extract<ThreadItem, { kind: "effect" }>;

/**
 * What a thread shows, from a page of a session's chain oldest first. A run becomes one `run`
 * item where it started and one `message` item per unbroken stretch of its words. A run whose
 * start is outside the page gets no `run` item, though its words on the page still show; an
 * effect whose request is outside the page is left out, as is a tool result without its call.
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
  const runs = new Map<string, RunItem>();
  const effects = new Map<string, EffectItem>();
  const items: ThreadItem[] = [];
  for (const segment of foldRuns(visible)) {
    switch (segment.type) {
      case "run.message": {
        const { id, ts, botId, runId, blocks } = segment;
        items.push({ kind: "message", role: "bot", id, ts, botId, runId, blocks });
        break;
      }
      case "user.message":
        items.push({
          kind: "message",
          role: "user",
          id: segment.id,
          ts: segment.ts,
          ...segment.payload,
        });
        break;
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
      case "handoff": {
        const { fromBotId, toBotId, text } = segment.payload;
        items.push({ kind: "handoff", id: segment.id, ts: segment.ts, fromBotId, toBotId, text });
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
        items.push({ kind: "note", ...note });
        break;
      }
      default:
        segment satisfies Exclude<SessionEntry, UiEntry>;
    }
  }
  return items;
}
