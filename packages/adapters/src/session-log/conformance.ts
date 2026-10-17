import type {
  NewSession,
  RunSearchInput,
  SessionAppendRefusal,
  SessionEntryDraft,
  SessionLog,
} from "@rakazo/adapter-kit";
import type { SessionEntry } from "@rakazo/contracts";
import { EntryId, EntrySeq, SessionId } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
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

    function searchInput(sessionId: SessionId, runId: string, query: string): RunSearchInput {
      return {
        scope: { sessionId, runId, botId: BOT, authorizationKey: "conformance" },
        query,
        redaction: { redact: (text) => text },
      };
    }

    it("recovers retained literal tool output beyond replay caps after compaction, without reasoning or JSON", async () => {
      const { sessionId, runId } = await created();
      const ofRun = { sessionId, runId, botId: BOT };
      await append({
        ...ofRun,
        type: "tool.call",
        payload: { callId: "receipt", name: "lookup", input: "private-input" },
      });
      const receipt = await append({
        ...ofRun,
        type: "tool.result",
        payload: {
          callId: "receipt",
          output: `${"x".repeat(180_000)} receipt_%_B731 done`,
          isError: false,
          artifactIds: [],
        },
      });
      await append({
        ...ofRun,
        type: "assistant.reasoning",
        payload: { text: "reasoning_%_B731" },
      });
      const text = await append(replied(sessionId, runId, "Visible response"));
      await append(compacted(text, text.seq));
      const found = await harness.log.searchRun(searchInput(sessionId, runId, "RECEIPT_%_b731"));
      expect(found).toMatchObject({
        status: "ok",
        hits: [{ entryId: receipt.id, runId, sessionId, ts: receipt.ts }],
        nextCursor: null,
        incomplete: false,
      });
      if (found.status !== "ok") throw new Error("Expected search page");
      expect(found.hits.map((hit) => hit.excerpt.includes("receipt_%_B731 done"))).toEqual([true]);
      expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(4000);
      expect(
        await harness.log.searchRun(searchInput(sessionId, runId, "reasoning_%_B731")),
      ).toEqual({ status: "ok", hits: [], nextCursor: null, incomplete: false, limitations: [] });
      expect(await harness.log.searchRun(searchInput(sessionId, runId, "private-input"))).toEqual({
        status: "ok",
        hits: [],
        nextCursor: null,
        incomplete: false,
        limitations: [],
      });
    });

    it("searches only active text and tool results with an active matching call, then excludes cleared history", async () => {
      const { sessionId, runId } = await created();
      const ofRun = { sessionId, runId, botId: BOT };
      const keep = await append(replied(sessionId, runId, "receipt retained"));
      await append({
        ...ofRun,
        type: "tool.call",
        payload: { callId: "removed", name: "lookup", input: "{}" },
      });
      await append(replied(sessionId, runId, "receipt removed"));
      const input = searchInput(sessionId, runId, "receipt");
      expect(await harness.log.searchRun(input)).toMatchObject({
        hits: [{ entryId: keep.id }, { excerpt: "receipt removed" }],
      });
      await append({ sessionId, type: "rewind", parentId: keep.id, payload: {} });
      await append({
        ...ofRun,
        type: "tool.result",
        payload: { callId: "removed", output: "receipt orphan", isError: false, artifactIds: [] },
      });
      const after = await harness.log.searchRun(input);
      expect(after).toMatchObject({
        hits: [{ entryId: keep.id, excerpt: "receipt retained" }],
        nextCursor: null,
      });
      if (after.status !== "ok") throw new Error("Expected search page");
      expect(after.hits.map((hit) => hit.entryId)).toEqual([keep.id]);
      await append({ sessionId, type: "clear", payload: {} });
      expect(await harness.log.searchRun(input)).toEqual({
        status: "ok",
        hits: [],
        nextCursor: null,
        incomplete: false,
        limitations: [],
      });
    });

    it("pages a stable snapshot, binds cursor scope and query, rejects cuts and too-small budgets", async () => {
      const { sessionId, runId } = await created();
      const written = await appendAll(
        Array.from({ length: 16 }, (_, i) => ({
          ...replied(sessionId, runId, `receipt ${i}`),
          ts: "2026-10-17T00:00:00.000Z",
        })),
      );
      const input = searchInput(sessionId, runId, "receipt");
      const first = await harness.log.searchRun(input);
      expect(first).toMatchObject({ status: "ok", incomplete: true });
      if (first.status !== "ok" || !first.nextCursor) throw new Error("Expected continuation");
      expect(first.hits.map((hit) => hit.excerpt)).toEqual(
        Array.from({ length: 10 }, (_, i) => `receipt ${i}`),
      );
      await append(replied(sessionId, runId, "receipt later"));
      const second = await harness.log.searchRun({ ...input, cursor: first.nextCursor });
      expect(second).toMatchObject({
        hits: written.slice(10).map((e) => ({ entryId: e.id })),
        nextCursor: null,
        incomplete: false,
      });
      expect(
        await harness.log.searchRun({ ...input, query: "later", cursor: first.nextCursor }),
      ).toEqual({ status: "unavailable", reason: "invalid_cursor" });
      expect(
        await harness.log.searchRun({
          ...input,
          scope: { ...input.scope, authorizationKey: "other" },
          cursor: first.nextCursor,
        }),
      ).toEqual({ status: "unavailable", reason: "invalid_cursor" });
      expect(await harness.log.searchRun({ ...input, cursor: "invalid" })).toEqual({
        status: "unavailable",
        reason: "invalid_cursor",
      });
      expect(await harness.log.searchRun({ ...input, maxBytes: 128 })).toEqual({
        status: "unavailable",
        reason: "budget_too_small",
      });
      await append({ sessionId, type: "rewind", parentId: written[0]!.id, payload: {} });
      expect(await harness.log.searchRun({ ...input, cursor: first.nextCursor })).toEqual({
        status: "unavailable",
        reason: "stale_cursor",
      });
    });

    it("finds a receipt after 162 nonmatching retained actions in one search call", async () => {
      const { sessionId, runId } = await created();
      await appendAll(
        Array.from({ length: 162 }, () => replied(sessionId, runId, "Earlier retained output")),
      );
      await append(replied(sessionId, runId, "receipt late-action-163"));
      expect(
        await harness.log.searchRun(searchInput(sessionId, runId, "late-action-163")),
      ).toMatchObject({
        hits: [{ excerpt: "receipt late-action-163" }],
        nextCursor: null,
        incomplete: false,
      });
    });

    it("advances an empty bounded scan page until a later retained match", async () => {
      const { sessionId, runId } = await created();
      await appendAll(
        Array.from({ length: 300 }, (_, i) =>
          replied(sessionId, runId, i === 299 ? "receipt late" : "Other output"),
        ),
      );
      const input = searchInput(sessionId, runId, "receipt");
      const first = await harness.log.searchRun(input);
      expect(first).toMatchObject({ status: "ok", hits: [], incomplete: true });
      if (first.status !== "ok" || !first.nextCursor) throw new Error("Expected scan continuation");
      expect(await harness.log.searchRun({ ...input, cursor: first.nextCursor })).toMatchObject({
        hits: [{ excerpt: "receipt late" }],
        incomplete: false,
        nextCursor: null,
      });
    });

    it("searches a child trace and its raised text as bounded snapshot phases", async () => {
      const { sessionId, runId, session } = await created();
      const childId = SessionId.parse(`search-child-${runId}`);
      await harness.transaction((tx) =>
        harness.log.createSession(tx, {
          kind: "routine",
          id: childId,
          spaceId: session.spaceId,
          parentSessionId: sessionId,
        }),
      );
      const child = await append(replied(childId, runId, "receipt in trace"));
      const raised = await append(replied(sessionId, runId, "receipt in parent"));
      const input = {
        ...searchInput(childId, runId, "receipt"),
        scope: { ...searchInput(childId, runId, "receipt").scope, raisedSessionId: sessionId },
      };
      const first = await harness.log.searchRun(input);
      expect(first).toMatchObject({ hits: [{ entryId: child.id }], incomplete: true });
      if (first.status !== "ok" || !first.nextCursor) throw new Error("Expected parent phase");
      await append(replied(sessionId, runId, "receipt later"));
      expect(await harness.log.searchRun({ ...input, cursor: first.nextCursor })).toMatchObject({
        hits: [{ entryId: raised.id, excerpt: "receipt in parent" }],
        incomplete: false,
        nextCursor: null,
      });
    });

    it.each([
      {
        name: "redacts a second secret after a masked first match",
        gap: 398,
        tail: "needle fake-credential-BBBBBBBBBBBBBBBB",
      },
      {
        name: "finds a public match beyond a masked first match",
        gap: 1000,
        tail: "needle public",
      },
    ])("$name", async ({ gap, tail }) => {
      const { sessionId, runId } = await created();
      const secrets = ["needleAAAAAAAAAAAAAAAAAAAAAAAAAA", "fake-credential-BBBBBBBBBBBBBBBB"];
      await append(replied(sessionId, runId, `${secrets[0]}${"x".repeat(gap)}${tail}`));
      const input = {
        ...searchInput(sessionId, runId, "needle"),
        redaction: { redact: (value: string) => redactSecrets(value, secrets) },
      };
      const result = await harness.log.searchRun(input);
      expect(result).toMatchObject({
        status: "ok",
        hits: [
          { excerpt: expect.stringContaining(gap === 398 ? "needle [redacted]" : "needle public") },
        ],
      });
      expect(JSON.stringify(result).includes("fake-credential")).toBe(false);
    });

    it.each([1, 2, 4])("masks retained JSON strings at %i nesting levels before archive matching", async (depth) => {
      const { sessionId, runId } = await created();
      const secret = 'fake-line-one"\\\nfake-line-two';
      let output = JSON.stringify({ receipt: "receipt K731", credential: secret });
      for (let level = 0; level < depth; level++) output = JSON.stringify({ text: output });
      await append({ sessionId, runId, botId: BOT, type: "tool.call",
        payload: { callId: "nested", name: "web_fetch", input: "{}" } });
      const stored = await append({ sessionId, runId, botId: BOT, type: "tool.result",
        payload: { callId: "nested", output, isError: false, artifactIds: [] } });
      const input = { ...searchInput(sessionId, runId, "K731"),
        redaction: { redact: (text: string) => redactSecrets(text, ["fake-line-one", secret]) } };
      const found = await harness.log.searchRun(input);
      expect(found).toMatchObject({ status: "ok", hits: [{ entryId: stored.id }] });
      if (found.status !== "ok" || !found.hits[0]) throw new Error("Missing receipt");
      expect(found.hits[0].excerpt).toContain("receipt K731");
      expect(found.hits[0].excerpt).toContain("[redacted]");
      expect(found.hits[0].excerpt).not.toContain("fake-line");
      for (const query of ["fake-line-one", "fake-line-two"]) {
        expect(await harness.log.searchRun({ ...input, query })).toMatchObject({
          status: "ok", hits: [], nextCursor: null,
        });
      }
    });

    it("reports an incomplete search when a missing parent hides retained text", async () => {
      const { sessionId, runId } = await created();
      await append(replied(sessionId, runId, "receipt retained before break"));
      const middle = await append(replied(sessionId, runId, "middle"));
      const latest = await append(replied(sessionId, runId, "latest visible"));
      const input = searchInput(sessionId, runId, "receipt");
      expect(await harness.log.searchRun(input)).toMatchObject({
        hits: [{ excerpt: "receipt retained before break" }],
        incomplete: false,
      });
      await harness.dropEntry(middle);
      expect(await harness.log.searchRun(input)).toMatchObject({
        status: "ok",
        hits: [],
        incomplete: true,
        limitations: ["unreadable_records"],
      });
      expect(await harness.log.searchRun({ ...input, query: "latest" })).toMatchObject({
        hits: [{ entryId: latest.id, excerpt: "latest visible" }],
        incomplete: true,
      });
    });

    it("masks known secrets before clipping or matching, including snippet boundaries", async () => {
      const { sessionId, runId } = await created();
      const secret = `fake-credential-${"z".repeat(210)}`;
      await append(replied(sessionId, runId, `receipt ${"a".repeat(130)} ${secret} end`));
      const input = {
        ...searchInput(sessionId, runId, "receipt"),
        redaction: {
          redact: (text: string) => redactSecrets(text, [secret]),
        },
      };
      expect(await harness.log.searchRun(input)).toMatchObject({
        hits: [{ excerpt: `receipt ${"a".repeat(130)} [redacted] end` }],
      });
      expect(await harness.log.searchRun({ ...input, query: "fake-credential" })).toMatchObject({
        status: "ok",
        hits: [],
        nextCursor: null,
      });
    });

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

    it("reads a child run whole: its trace, what it raised and the answers to its asks, by time", async () => {
      const { sessionId, runId, session } = await created();
      const childId = SessionId.parse(`routine-${runId}`);
      await harness.transaction((tx) =>
        harness.log.createSession(tx, {
          kind: "routine",
          id: childId,
          spaceId: session.spaceId,
          parentSessionId: sessionId,
        }),
      );
      const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 9, 0, second)).toISOString();
      const ofRun = { botId: BOT, runId };
      const askId = EntryId.parse(crypto.randomUUID());
      const [started, call, result, ask, answer, , card, done] = await appendAll([
        {
          ...ofRun,
          sessionId: childId,
          ts: at(0),
          type: "run.started",
          payload: { trigger: { kind: "direct" }, model: { provider: "p", id: "m" }, effort: null },
        },
        {
          ...ofRun,
          sessionId: childId,
          ts: at(1),
          type: "tool.call",
          payload: { callId: "call_0", name: "search", input: "{}" },
        },
        {
          ...ofRun,
          sessionId: childId,
          ts: at(2),
          type: "tool.result",
          payload: { callId: "call_0", output: "3 hits", isError: false, artifactIds: [] },
        },
        {
          ...ofRun,
          id: askId,
          sessionId,
          ts: at(3),
          type: "assistant.ask",
          payload: { block: { kind: "ask", text: "Which outlet?" }, originSessionId: childId },
        },
        {
          sessionId,
          ts: at(4),
          type: "user.message",
          payload: {
            blocks: [{ kind: "text", text: "Le Monde" }],
            replyTo: { entryId: askId },
            source: "app",
          },
        },
        { ...said(sessionId, "unrelated"), ts: at(5) },
        {
          ...ofRun,
          sessionId,
          ts: at(6),
          type: "assistant.text",
          payload: {
            blocks: [
              {
                kind: "mcp_approval",
                name: "Press",
                serverId: "mcp_press",
                transport: "streamable_http",
                endpoint: null,
                needsOAuth: false,
              },
            ],
            originSessionId: childId,
          },
        },
        { ...replied(childId, runId, "Done."), ts: at(7) },
      ]);

      expect(await harness.log.readRun(runId)).toEqual([
        started,
        call,
        result,
        ask,
        answer,
        card,
        done,
      ]);
      expect(await harness.log.readRun(runId, { limit: 3 })).toEqual([answer, card, done]);
      expect(await harness.log.readTail(childId)).toEqual([started, call, result, done]);
    });

    it("reads the later state of a run's cards with the run, by time, and no other card's", async () => {
      const { sessionId, runId } = await created();
      const at = (second: number) => new Date(Date.UTC(2026, 9, 11, 9, 0, second)).toISOString();
      const ofRun = { sessionId, botId: BOT, runId };
      const askId = EntryId.parse(crypto.randomUUID());
      const approvalId = EntryId.parse(crypto.randomUUID());
      const [ask, answered, approval, , applied] = await appendAll([
        {
          ...ofRun,
          id: askId,
          ts: at(0),
          type: "assistant.ask",
          payload: { block: { kind: "ask", text: "Your API key?", input: "secret" } },
        },
        { sessionId, ts: at(1), type: "card.answered", payload: { target: askId, answer: "" } },
        {
          ...ofRun,
          id: approvalId,
          ts: at(2),
          type: "effect.requested",
          payload: { effectId: "effect_1", effectKind: "routine", proposal: { name: "Digest" } },
        },
        { ...said(sessionId, "unrelated"), ts: at(3) },
        {
          sessionId,
          ts: at(4),
          type: "effect.applied",
          payload: { target: approvalId, routineId: "routine_1", change: "created" },
        },
      ]);
      await append({
        sessionId,
        ts: at(5),
        type: "card.answered",
        payload: { target: EntryId.parse(crypto.randomUUID()), dismissed: true },
      });

      expect(await harness.log.readRun(runId)).toEqual([ask, answered, approval, applied]);
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

    it("reads the chain around an entry, and nothing for an entry a rewind left off it", async () => {
      const { sessionId } = await created();
      const [e0, e1, , e3, , e5] = await appendAll(
        ["e0", "e1", "e2", "e3", "e4", "e5"].map((text) => said(sessionId, text)),
      );
      const rewind = await append({ sessionId, type: "rewind", parentId: e3!.id, payload: {} });
      await append(said(sessionId, "e4 edited"));
      const around = async (entry: SessionEntry, limit: number) =>
        (await harness.log.readAround(sessionId, entry.id, limit)).map(textOf);

      expect(await around(e3!, 4)).toEqual(["e1", "e2", "e3", "rewind"]);
      expect(await around(e1!, 5)).toEqual(["e0", "e1", "e2", "e3", "rewind"]);
      expect(await around(e0!, 3)).toEqual(["e0", "e1", "e2"]);
      expect(await around(rewind, 4)).toEqual(["e2", "e3", "rewind", "e4 edited"]);
      expect(await around(rewind, 7)).toEqual(["e1", "e2", "e3", "rewind", "e4 edited"]);
      expect(await around(e5!, 4)).toEqual([]);
      await expect(around(e0!, 0)).rejects.toThrow(RangeError);
    });

    it("reads a page and around an entry inside the transaction it is given", async () => {
      const { sessionId } = await created();
      const kept = await append(said(sessionId, "kept"));

      const read = await harness.transaction(async (tx) => {
        await harness.log.append(tx, { ...said(sessionId, "same transaction"), feedBotId: BOT });
        return [
          (await harness.log.readPage(sessionId, { limit: 10 }, tx)).map(textOf),
          (await harness.log.readAround(sessionId, kept.id, 10, tx)).map(textOf),
        ];
      });

      expect(read).toEqual([
        ["kept", "same transaction"],
        ["kept", "same transaction"],
      ]);
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
      const { sessionId: parentId, session, runId } = await created();
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
          append(replied(childId, runId, `child ${index}`)),
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
