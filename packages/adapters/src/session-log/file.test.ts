import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntryDraft } from "@tangow/adapter-kit";
import { SessionId } from "@tangow/contracts";
import { decodeEntries, encodeEntries } from "@tangow/core";
import { describe, expect, it } from "vitest";
import { runSessionLogConformance } from "./conformance.js";
import { FileSessionLog } from "./file.js";

function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "tangow-session-log-"));
}

runSessionLogConformance(async () => {
  const root = await temporaryRoot();
  return {
    log: new FileSessionLog(root),
    transaction: (work) => work(undefined),
    async threadSession() {
      const id = crypto.randomUUID();
      return {
        session: {
          kind: "thread",
          id: SessionId.parse(`ses-${id}`),
          spaceId: "space",
          threadId: `thread-${id}`,
        },
        runId: `run-${id}`,
      };
    },
    async dropEntry(entry) {
      const file = path.join(root, "sessions", `${entry.sessionId}.jsonl`);
      const kept = decodeEntries(await readFile(file, "utf8")).filter(({ id }) => id !== entry.id);
      await writeFile(file, encodeEntries(kept));
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
});

describe("FileSessionLog", () => {
  const sessionId = SessionId.parse("ses_crash");
  const said = (text: string): SessionEntryDraft => ({
    sessionId,
    type: "user.message",
    payload: { blocks: [{ kind: "text", text }], source: "app" },
  });

  it.each([
    { crash: "cut the last line short", cutBytes: 12, survivors: 2 },
    { crash: "left the last line without its newline", cutBytes: 1, survivors: 3 },
  ])("continues the chain after a crash $crash", async ({ cutBytes, survivors }) => {
    const root = await temporaryRoot();
    const file = path.join(root, "sessions", `${sessionId}.jsonl`);
    const before = new FileSessionLog(root);
    await before.createSession(undefined, {
      kind: "thread",
      id: sessionId,
      spaceId: "space",
      threadId: "thread",
    });
    const written = [];
    for (const text of ["a", "b", "c"]) written.push(await before.append(undefined, said(text)));
    await truncate(file, (await stat(file)).size - cutBytes);

    const after = new FileSessionLog(root);
    const kept = written.slice(0, survivors);
    expect(await after.readTail(sessionId)).toEqual(kept);
    const next = await after.append(undefined, said("d"));

    expect([next.seq, next.parentId]).toEqual([survivors, kept.at(-1)!.id]);
    expect(decodeEntries(await readFile(file, "utf8"))).toEqual([...kept, next]);
    await rm(root, { recursive: true, force: true });
  });

  it("skips oversized records explicitly and advances through later pages after reopening", async () => {
    const root = await temporaryRoot();
    const log = new FileSessionLog(root);
    await log.createSession(undefined, {
      kind: "thread",
      id: sessionId,
      spaceId: "space",
      threadId: "thread",
    });
    const ofRun = { sessionId, botId: "bot", runId: "old-run" };
    await log.append(undefined, {
      ...ofRun,
      type: "assistant.text",
      payload: { blocks: [{ kind: "text", text: `hidden receipt ${"x".repeat(1_100_000)}` }] },
    });
    for (let i = 0; i < 13; i++)
      await log.append(undefined, {
        ...ofRun,
        type: "assistant.text",
        payload: { blocks: [{ kind: "text", text: `receipt ${i}` }] },
      });
    const input = {
      scope: { ...ofRun, authorizationKey: "file" },
      query: "receipt",
      redaction: { redact: (value: string) => value },
    };
    const first = await log.searchRun(input);
    expect(first).toMatchObject({
      status: "ok",
      limitations: expect.arrayContaining(["oversized_records"]),
      incomplete: true,
    });
    if (first.status !== "ok" || !first.nextCursor) throw new Error("Expected continuation");
    const second = await new FileSessionLog(root).searchRun({ ...input, cursor: first.nextCursor });
    expect(second).toMatchObject({
      hits: [{ excerpt: "receipt 10" }, { excerpt: "receipt 11" }, { excerpt: "receipt 12" }],
      nextCursor: null,
      incomplete: true,
      limitations: expect.arrayContaining(["oversized_records"]),
    });
    expect(first.hits.map((hit) => hit.excerpt)).toEqual(
      Array.from({ length: 10 }, (_, i) => `receipt ${i}`),
    );
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a session id that is not a safe file name", async () => {
    const root = await temporaryRoot();
    const log = new FileSessionLog(root);

    await expect(log.readTail(SessionId.parse("../escape"))).rejects.toThrow(
      'Session id "../escape" is not a safe file name',
    );
    await rm(root, { recursive: true, force: true });
  });
});
