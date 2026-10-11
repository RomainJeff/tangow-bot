import type {
  NewSession,
  SessionAppendRefusal,
  SessionEntryDraft,
  SessionLog,
} from "@rakazo/adapter-kit";
import type { SessionEntry } from "@rakazo/contracts";
import { EntryId, EntrySeq, SessionId } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

export interface SessionLogHarness<Tx> {
  log: SessionLog<Tx>;
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /** A fresh thread session, not yet created through the log, and a run on its thread. */
  threadSession(): Promise<{ session: Extract<NewSession, { kind: "thread" }>; runId: string }>;
  /** Remove an entry behind the log's back, as a bad manual edit would. */
  dropEntry(entry: SessionEntry): Promise<void>;
  close(): Promise<void>;
}

const BOT = "bot_conformance";

function said(sessionId: SessionId, text: string): SessionEntryDraft {
  return {
    sessionId,
    type: "user.message",
    payload: { blocks: [{ kind: "text", text }], source: "app" },
  };
}

function replied(sessionId: SessionId, runId: string, text: string): SessionEntryDraft {
  return {
    sessionId,
    botId: BOT,
    runId,
    type: "assistant.text",
    payload: { blocks: [{ kind: "text", text }] },
  };
}

function compacted(head: SessionEntry, coveredUpToSeq: number): SessionEntryDraft {
  return {
    sessionId: head.sessionId,
    type: "compaction",
    parentId: head.id,
    payload: { summary: `up to ${coveredUpToSeq}`, coveredUpToSeq: EntrySeq.parse(coveredUpToSeq) },
  };
}

function textOf(entry: SessionEntry): string {
  if (entry.type === "user.message" || entry.type === "assistant.text") {
    return entry.payload.blocks.map((block) => (block.kind === "text" ? block.text : "")).join("");
  }
  return entry.type === "compaction" ? entry.payload.summary : entry.type;
}

function expectLinearChain(entries: readonly SessionEntry[]): void {
  expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index));
  expect(entries.map((entry) => entry.parentId)).toEqual([
    null,
    ...entries.slice(0, -1).map((entry) => entry.id),
  ]);
}

/** The contract every `SessionLog` backend keeps. Deterministic and offline. */
export function runSessionLogConformance<Tx>(makeLog: () => Promise<SessionLogHarness<Tx>>): void {
  describe("session log conformance", () => {
    let harness: SessionLogHarness<Tx>;

    beforeAll(async () => {
      harness = await makeLog();
    });
    afterAll(() => harness.close());

    async function created() {
      const fresh = await harness.threadSession();
      await harness.transaction((tx) => harness.log.createSession(tx, fresh.session));
      return { sessionId: fresh.session.id, runId: fresh.runId, session: fresh.session };
    }

    function append(draft: SessionEntryDraft): Promise<SessionEntry> {
      return harness.transaction((tx) => harness.log.append(tx, { ...draft, feedBotId: BOT }));
    }

    async function appendAll(drafts: readonly SessionEntryDraft[]): Promise<SessionEntry[]> {
      const entries: SessionEntry[] = [];
      for (const draft of drafts) entries.push(await append(draft));
      return entries;
    }

    it("appends in order, each entry's parent the one before, and reads them back", async () => {
      const { sessionId, runId } = await created();
      const entries = await appendAll([
        said(sessionId, "hello"),
        replied(sessionId, runId, "hi"),
        said(sessionId, "bye"),
      ]);

      expectLinearChain(entries);
      expect(await harness.log.readTail(sessionId)).toEqual(entries);
    });

    it("creates a session idempotently and refuses an append to an unknown session", async () => {
      const { sessionId, session } = await created();
      const first = await append(said(sessionId, "one"));
      await harness.transaction((tx) => harness.log.createSession(tx, session));
      const second = await append(said(sessionId, "two"));

      expect([second.seq, second.parentId]).toEqual([1, first.id]);
      await expect(append(said(SessionId.parse("ses_unknown"), "lost"))).rejects.toMatchObject({
        reason: "unknown_session",
      });
    });

    it("keeps one main session per thread", async () => {
      const { sessionId, session } = await created();
      const other = SessionId.parse(`other-${sessionId}`);

      const resolved = await harness.transaction((tx) =>
        harness.log.createSession(tx, { ...session, id: other }),
      );

      expect(resolved).toBe(sessionId);
      await expect(append(said(other, "lost"))).rejects.toMatchObject({
        reason: "unknown_session",
      });
    });

    it("leaves rewound entries off the tail and keeps them for their run", async () => {
      const { sessionId, runId } = await created();
      const [question, ...answers] = await appendAll([
        said(sessionId, "question"),
        replied(sessionId, runId, "first answer"),
        replied(sessionId, runId, "second answer"),
      ]);
      const rewind = await append({
        sessionId,
        type: "rewind",
        parentId: question!.id,
        payload: { reason: "edit" },
      });
      const after = await append(said(sessionId, "edited question"));

      expect([rewind.seq, rewind.parentId, after.parentId]).toEqual([3, question!.id, rewind.id]);
      expect((await harness.log.readTail(sessionId)).map(textOf)).toEqual([
        "question",
        "rewind",
        "edited question",
      ]);
      expect(await harness.log.readRun(runId)).toEqual(answers);
    });

    it("reads one entry of its session whether the chain still holds it or not", async () => {
      const { sessionId, runId } = await created();
      const [question, answer] = await appendAll([
        said(sessionId, "question"),
        replied(sessionId, runId, "answer"),
      ]);
      const rewind = await append({
        sessionId,
        type: "rewind",
        parentId: question!.id,
        payload: {},
      });
      await append(compacted(rewind, 2));
      const elsewhere = await append(said((await created()).sessionId, "elsewhere"));

      expect(await harness.log.readEntry(sessionId, answer!.id)).toEqual(answer);
      expect(await harness.log.readEntry(sessionId, question!.id)).toEqual(question);
      expect(await harness.log.readEntry(sessionId, elsewhere.id)).toBeUndefined();
    });

    it("starts a new chain at a clear", async () => {
      const { sessionId } = await created();
      await appendAll([said(sessionId, "old"), said(sessionId, "older")]);
      const clear = await append({ sessionId, type: "clear", payload: {} });
      await append(said(sessionId, "fresh"));

      expect([clear.seq, clear.parentId]).toEqual([2, null]);
      expect((await harness.log.readTail(sessionId)).map(textOf)).toEqual(["clear", "fresh"]);
    });

    it("reads the tail from the newest compaction, then the chain after the seq it covers", async () => {
      const { sessionId } = await created();
      const [, , c] = await appendAll(["a", "b", "c"].map((text) => said(sessionId, text)));
      await append(compacted(c!, 0));
      await append(said(sessionId, "d"));
      const first = (await harness.log.readTail(sessionId)).map(textOf);
      const e = await append(said(sessionId, "e"));
      await append(compacted(e, 3));
      await append(said(sessionId, "f"));

      expect(first).toEqual(["up to 0", "b", "c", "d"]);
      expect((await harness.log.readTail(sessionId)).map(textOf)).toEqual([
        "up to 3",
        "d",
        "e",
        "f",
      ]);
    });

    it("reads back to what the newest compaction covers past an older compaction in its kept window", async () => {
      const { sessionId } = await created();
      const [, , c] = await appendAll(["a", "b", "c"].map((text) => said(sessionId, text)));
      await append(compacted(c!, 0));
      const d = await append(said(sessionId, "d"));
      await append(compacted(d, 1));
      await append(said(sessionId, "e"));

      expect((await harness.log.readTail(sessionId)).map(textOf)).toEqual([
        "up to 1",
        "c",
        "up to 0",
        "d",
        "e",
      ]);
    });

    it("reads a compaction written again on top of a rewind into its kept window, then the turns it kept", async () => {
      const { sessionId } = await created();
      const [, , c, d] = await appendAll(["a", "b", "c", "d"].map((text) => said(sessionId, text)));
      await append(compacted(d!, 1));
      const rewind = await append({ sessionId, type: "rewind", parentId: c!.id, payload: {} });
      await append(compacted(rewind, 1));
      await append(said(sessionId, "d edited"));

      expect((await harness.log.readTail(sessionId)).map(textOf)).toEqual([
        "up to 1",
        "c",
        "rewind",
        "d edited",
      ]);
    });

    it("keeps only the newest maxEntries of the tail, the compaction among them when reached", async () => {
      const { sessionId } = await created();
      const [, , c] = await appendAll(["a", "b", "c"].map((text) => said(sessionId, text)));
      await append(compacted(c!, 0));
      await append(said(sessionId, "d"));
      const tail = async (maxEntries: number) =>
        (await harness.log.readTail(sessionId, { maxEntries })).map(textOf);

      expect(await tail(1)).toEqual(["d"]);
      expect(await tail(3)).toEqual(["up to 0", "c", "d"]);
      expect(await tail(10)).toEqual(["up to 0", "b", "c", "d"]);
      await expect(tail(0)).rejects.toThrow(RangeError);
    });

    it("refuses a compaction whose parent is not the head, and a rewind outside the session", async () => {
      const { sessionId } = await created();
      const elsewhere = await append(said((await created()).sessionId, "elsewhere"));
      const entries = await appendAll([said(sessionId, "a"), said(sessionId, "b")]);
      const refused = [
        { draft: compacted(entries[0]!, 1), reason: "stale_compaction" },
        {
          draft: { sessionId, type: "rewind", parentId: elsewhere.id, payload: {} },
          reason: "missing_parent",
        },
      ] satisfies Array<{ draft: SessionEntryDraft; reason: SessionAppendRefusal }>;

      for (const { draft, reason } of refused) {
        await expect(append(draft)).rejects.toMatchObject({ reason });
      }
      expect(await harness.log.readTail(sessionId)).toEqual(entries);
    });

    it("pages back along the chain past a compaction", async () => {
      const { sessionId } = await created();
      const [e0, , e2] = await appendAll(["e0", "e1", "e2"].map((text) => said(sessionId, text)));
      await append(compacted(e2!, 2));
      const [e4] = await appendAll([said(sessionId, "e4"), said(sessionId, "e5")]);
      const page = async (before: SessionEntry | undefined, limit: number) =>
        (await harness.log.readPage(sessionId, { before: before?.id, limit })).map(textOf);

      expect(await page(undefined, 2)).toEqual(["e4", "e5"]);
      expect(await page(e4, 2)).toEqual(["e2", "up to 2"]);
      expect(await page(e2, 5)).toEqual(["e0", "e1"]);
      expect(await page(e0, 2)).toEqual([]);
    });

    it("keeps one entry for a redelivered clientNonce", async () => {
      const { sessionId } = await created();
      const received = (text: string): SessionEntryDraft => ({
        sessionId,
        type: "bot.message.received",
        payload: {
          from: { kind: "bot", botId: "bot_peer", name: "Peer" },
          fromSessionId: SessionId.parse("ses_peer"),
          fromEntryId: EntryId.parse("peer_entry"),
          text,
          intent: "result",
          hop: 1,
          exchangeId: EntryId.parse("peer_exchange"),
          clientNonce: "bot-message:delivery-1",
        },
      });
      const first = await append(received("Q3 revenue was 1.2M."));
      const again = await append(received("redelivered"));
      const next = await append(said(sessionId, "next"));

      expect(again).toEqual(first);
      expect([next.seq, next.parentId]).toEqual([1, first.id]);
      expect(await harness.log.readTail(sessionId)).toEqual([first, next]);
    });

    it("refuses to read a chain whose parent is missing", async () => {
      const { sessionId } = await created();
      const [, middle] = await appendAll([
        said(sessionId, "a"),
        said(sessionId, "b"),
        said(sessionId, "c"),
      ]);
      await harness.dropEntry(middle!);

      const refusal = {
        name: "SessionReadError",
        reason: "missing_parent",
        sessionId,
        parentId: middle!.id,
      };
      await expect(harness.log.readTail(sessionId)).rejects.toMatchObject(refusal);
      await expect(harness.log.readPage(sessionId, { limit: 10 })).rejects.toMatchObject(refusal);
      expect((await harness.log.readTail(sessionId, { maxEntries: 1 })).map(textOf)).toEqual(["c"]);
    });

    it("gives concurrent transactions on one session distinct seqs on one chain", async () => {
      const { sessionId } = await created();
      const entries = await Promise.all(
        Array.from({ length: 8 }, (_, index) => append(said(sessionId, `m${index}`))),
      );

      expectLinearChain(entries.toSorted((left, right) => left.seq - right.seq));
      expect(await harness.log.readTail(sessionId)).toHaveLength(8);
    });

    it("keeps the chains of a session and its subagent apart when both append at once", async () => {
      const { sessionId: parentId, session } = await created();
      const launch = await append(said(parentId, "delegate"));
      const childId = SessionId.parse(`child-${launch.id}`);
      await harness.transaction((tx) =>
        harness.log.createSession(tx, {
          kind: "subagent",
          id: childId,
          spaceId: session.spaceId,
          parentSessionId: parentId,
          parentEntryId: launch.id,
        }),
      );
      await Promise.all(
        Array.from({ length: 10 }, (_, index) => [
          append(said(parentId, `parent ${index}`)),
          append(said(childId, `child ${index}`)),
        ]).flat(),
      );

      const parent = await harness.log.readTail(parentId);
      const child = await harness.log.readTail(childId);
      const numbered = (prefix: string) =>
        Array.from({ length: 10 }, (_, index) => `${prefix} ${index}`).toSorted();
      expectLinearChain(parent);
      expectLinearChain(child);
      expect(parent.map(textOf).toSorted()).toEqual(["delegate", ...numbered("parent")].toSorted());
      expect(child.map(textOf).toSorted()).toEqual(numbered("child"));
    });
  });
}
