import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkerLifecycle, PiAgentRuntime } from "@rakazo/adapters";
import {
  createLifecycleLauncher,
  createStopJournal,
  createWorkerAgentRuntime,
} from "@rakazo/adapters/runtime-worker";
import { afterEach, describe, expect, it } from "vitest";
import { fileTask } from "./file-task.js";
import { LocalWorkerProvider } from "./local-worker-provider.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function runTask(arm: "in_process" | "worker") {
  const seen: string[] = [];
  let file: string | undefined;
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-worker-files-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let provider: LocalWorkerProvider | undefined;
  const run = await startWorkerRun({
    steps: fileTask(seen, () => {
      file =
        arm === "worker"
          ? readFileSync(path.join(provider!.volumePath("private"), "notes.md"), "utf8")
          : [...run.sandbox.boxes.values()]
              .map((box) => box.files.get("notes.md"))
              .filter((stored) => stored !== undefined)
              .map((stored) => Buffer.from(stored.content).toString())[0];
    }),
    runtime: (prisma) => {
      if (arm === "in_process") return new PiAgentRuntime();
      provider = new LocalWorkerProvider({ mode: "memory", root });
      return createWorkerAgentRuntime({
        launcher: createLifecycleLauncher({
          prisma,
          lifecycle: createWorkerLifecycle({ prisma, provider }),
          connector: provider,
          needs: { files: { private: "rw", shared: null }, computer: "none" },
        }),
        stops: createStopJournal(prisma),
      });
    },
  });
  cleanups.push(() => run.close());
  if (arm === "worker") {
    await run.homeOnVolumes();
    await run.prisma.volume.create({
      data: {
        kind: "bot_private",
        spaceId: run.bot.spaceId,
        botId: run.bot.id,
        providerKind: "local-worker",
        providerRef: "private",
      },
    });
  }
  const runId = await run.send("Write, edit, read and list a note.");
  await run.continueRun(runId);
  run.model.assertComplete();
  const results = (await run.runEntries(runId)).flatMap((entry) =>
    entry.type === "tool.result" ? [[entry.payload.output, entry.payload.isError]] : [],
  );
  return { seen, results, file };
}

describe("a file task in a worker", () => {
  it("leaves the same file and shows the model the same results as in process", async () => {
    const inProcess = await runTask("in_process");
    const worker = await runTask("worker");

    expect(inProcess.file).toBe("alpha\ngamma\n");
    expect(inProcess.seen).toEqual([
      '{"ok":true,"path":"notes.md"}',
      '{"error":"file already exists; use edit_file to change part of it, or set overwrite to true to replace it whole","path":"notes.md"}',
      '{"ok":true,"path":"notes.md","replacements":1}',
      '{"error":"old_text not found; read the file again with read_file and copy the text exactly","path":"notes.md"}',
      '{"path":"notes.md","content":"gamma\\n","startLine":2,"endLine":2,"totalLines":2}',
      '{"path":"","entries":[{"path":"notes.md","kind":"file","size":12}]}',
      expect.stringContaining('"ok":true'),
    ]);
    expect(worker.file).toBe(inProcess.file);
    expect(worker.seen).toEqual(inProcess.seen);
    expect(worker.results).toEqual(inProcess.results);
  });
});
