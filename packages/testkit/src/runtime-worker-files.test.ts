import { readFileSync } from "node:fs";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { afterEach, describe, expect, it } from "vitest";
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
  const run = await startWorkerRun({
    steps: fileTask(seen, () => {
      file = readFileSync(path.join(run.provider.volumePath("bot_private"), "notes.md"), "utf8");
    }),
    ...(arm === "in_process" ? { runtime: () => new PiAgentRuntime() } : {}),
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

describe("a product run in a worker", () => {
  it("shares the bot's and the space's files with the computer, both ways", async () => {
    const seen: string[] = [];
    let run: Awaited<ReturnType<typeof startWorkerRun>>;
    const computer = {
      id: "fake-worker-computer",
      botId: "worker-computer",
      kind: "e2b" as const,
      providerRef: "fake-worker-computer",
    };
    const context = {
      operationId: "files",
      traceId: "files",
      spaceId: "space-worker",
      userId: "user-worker",
      signal: new AbortController().signal,
    };
    const step = (name: string, args: () => Record<string, unknown>): ModelEmulatorStep => ({
      expect: (request) => void seen.push(toolResult(request)),
      response: () => ({ type: "tool", id: `call-${name}`, name, arguments: args() }),
    });
    run = await startWorkerRun({
      computerScope: "team",
      steps: [
        {
          // A person working on the computer while the run starts.
          async expect() {
            await run.sandbox.writeFile(
              computer,
              {
                path: `bots/${run.bot.id}/from-computer.txt`,
                content: Buffer.from("written on the computer"),
              },
              context,
            );
          },
          response: {
            type: "tool",
            id: "call-bash",
            name: "bash",
            arguments: {
              command: "printf 'alpha\\n' > notes.md && cat from-computer.txt",
            },
          },
        },
        step("write_file", () => ({ path: "shared/team.txt", content: "team\n" })),
        step("edit_file", () => ({ path: "notes.md", old_text: "alpha", new_text: "beta" })),
        step("grep", () => ({ pattern: "be.a" })),
        step("attach_file", () => ({ path: `/workspace/bots/${run.bot.id}/notes.md` })),
        step("message_user", () => ({ message: "Done." })),
        {
          expect: (request) => void seen.push(toolResult(request)),
          response: { type: "text", text: recap },
        },
      ],
    });
    cleanups.push(() => run.close());
    const runId = await run.send("Work on the notes.");
    await run.continueRun(runId);
    run.model.assertComplete();

    expect(seen.slice(0, 4)).toEqual([
      "written on the computer",
      '{"ok":true,"path":"shared/team.txt"}',
      '{"ok":true,"path":"notes.md","replacements":1}',
      "notes.md:1:beta",
    ]);
    expect(JSON.parse(seen[4]!)).toMatchObject({
      ok: true,
      path: `/workspace/bots/${run.bot.id}/notes.md`,
    });
    const read = async (file: string) =>
      Buffer.from(await run.sandbox.readFile(computer, file, context)).toString();
    expect(await read(`bots/${run.bot.id}/notes.md`)).toBe("beta\n");
    expect(await read("shared/team.txt")).toBe("team\n");
  });
});
