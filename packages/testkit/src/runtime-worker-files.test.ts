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
import { LocalWorkerProvider } from "./local-worker-provider.js";
import type { ModelEmulatorRequest, ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const toolResult = (request: ModelEmulatorRequest) =>
  String(request.messages.findLast((message) => message.role === "tool")?.content);

const recap = JSON.stringify({ version: 1, results: ["Edited notes.md"], references: [] });

/** The same file task, step by step: what the model sees after each call is kept in `seen`. */
function fileTask(seen: string[], atEnd: () => void): ModelEmulatorStep[] {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["write_file", { path: "notes.md", content: "alpha\nbeta\n" }],
    ["write_file", { path: "notes.md", content: "again" }],
    ["edit_file", { path: "notes.md", old_text: "beta", new_text: "gamma" }],
    ["edit_file", { path: "notes.md", old_text: "delta", new_text: "x" }],
    ["read_file", { path: "notes.md", offset: 2 }],
    ["list_files", {}],
    ["message_user", { message: "Done." }],
  ];
  return [
    ...calls.map(
      ([name, args], index): ModelEmulatorStep => ({
        expect(request) {
          if (index > 0) seen.push(toolResult(request));
        },
        response: { type: "tool", id: `call-${index}`, name, arguments: args },
      }),
    ),
    {
      expect(request) {
        seen.push(toolResult(request));
        atEnd();
      },
      response: { type: "text", text: recap },
    },
  ];
}

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
          ? readFileSync(
              path.join(root, provider!.launches[0]!, "workspace/bots", run.bot.id, "notes.md"),
              "utf8",
            )
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
        }),
        stops: createStopJournal(prisma),
      });
    },
  });
  cleanups.push(() => run.close());
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
