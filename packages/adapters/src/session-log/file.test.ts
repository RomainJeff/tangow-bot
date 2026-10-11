import { mkdtemp, readFile, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import { SessionId } from "@rakazo/contracts";
import { decodeEntries } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { runSessionLogConformance } from "./conformance.js";
import { FileSessionLog } from "./file.js";

function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "rakazo-session-log-"));
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

  it("refuses a session id that is not a safe file name", async () => {
    const root = await temporaryRoot();
    const log = new FileSessionLog(root);

    await expect(log.readTail(SessionId.parse("../escape"))).rejects.toThrow(
      'Session id "../escape" is not a safe file name',
    );
    await rm(root, { recursive: true, force: true });
  });
});
