import { readFileSync } from "node:fs";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { WORKER_NATIVE_TOOLS } from "@rakazo/adapters/runtime-worker";
import { HARNESSES } from "@rakazo/agent-run-worker";
import { afterEach, describe, expect, it } from "vitest";
import { fileTask, nativeFileTask, toolResult } from "./file-task.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const recap = JSON.stringify({ version: 1, results: ["Edited notes.md"], references: [] });

async function runTask(arm: "in_process" | "worker") {
  const seen: string[] = [];
  let file: string | undefined;
  const run = await startWorkerRun({
    steps: (arm === "worker" ? nativeFileTask : fileTask)(seen, () => {
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
  it("leaves the same final file as in process through the native tool contracts", async () => {
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
    expect(worker.seen[0]).toContain("Successfully wrote");
    expect(worker.seen[1]).toContain("Successfully replaced");
    expect(worker.seen[2]).toContain("Could not find");
    expect(worker.seen[3]).toContain("gamma");
    expect(worker.seen[4]).toContain("notes.md");
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
          async expect(request) {
            const instructions = JSON.stringify(request.messages);
            expect(instructions).toContain(`/workspace/bots/${run.bot.id}`);
            expect(instructions).toContain("/workspace/shared");
            expect(instructions).not.toContain("Put intentionally shared work under shared/");
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
        step("write", () => ({ path: "../../shared/team.txt", content: "team\n" })),
        step("edit", () => ({ path: "notes.md", edits: [{ oldText: "alpha", newText: "beta" }] })),
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

    expect(seen[0]).toBe("written on the computer");
    expect(seen[1]).toContain("Successfully wrote");
    expect(seen[2]).toContain("Successfully replaced");
    expect(seen[3]).toContain("notes.md:1: beta");
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

it.each(["after", "during"] as const)(
  "reads fresh native state after an attempt is cut %s a read",
  async (cut) => {
    let version = "v1";
    let run: Awaited<ReturnType<typeof startWorkerRun>>;
    const results: unknown[] = [];
    run = await startWorkerRun({
      steps: [],
      runtime: () => ({
        describe: () => ({
          ...new PiAgentRuntime().describe(),
          id: "worker",
          capabilities: { scripted: false, localTools: WORKER_NATIVE_TOOLS },
        }),
        async *run(request, context) {
          const interrupt = async () => {
            await run.prisma.run.update({
              where: { id: request.runId },
              data: { leaseFence: { increment: 1 }, leaseExpiresAt: new Date(0) },
            });
            throw new Error("Attempt interrupted");
          };
          const cwd = run.provider.volumePath("bot_private");
          const nativeContext = {
            cwd,
            spoolDir: path.join(cwd, ".spool"),
            signal: context.signal,
          };
          yield {
            type: "tool",
            name: "write",
            args: { path: "retry.txt", content: version },
            executionId: "write",
          };
          await request.executeLocalTool!(
            "write",
            { path: "retry.txt", content: version },
            "write",
            (signal) =>
              HARNESSES.pi.executeNativeTool(
                "write",
                { path: "retry.txt", content: version },
                "write",
                { ...nativeContext, signal },
              ),
          );
          yield {
            type: "tool",
            name: "read",
            args: { path: "retry.txt" },
            executionId: "read",
          };
          results.push(
            await request.executeLocalTool!(
              "read",
              { path: "retry.txt" },
              "read",
              async (signal) => {
                if (version === "v1" && cut === "during") await interrupt();
                return HARNESSES.pi.executeNativeTool("read", { path: "retry.txt" }, "read", {
                  ...nativeContext,
                  signal,
                });
              },
            ),
          );
          if (version === "v1") await interrupt();
          yield { type: "done", text: "Done." };
        },
      }),
    });
    cleanups.push(() => run.close());
    const runId = await run.send("Read current state.");
    await run.continueRun(runId);
    version = "v2";
    await run.prisma.run.update({
      where: { id: runId },
      data: { status: "queued", leaseOwner: null, leaseExpiresAt: null },
    });
    await run.restart().dispose();
    await run.continueRun(runId);
    expect(
      await run.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true, error: true },
      }),
    ).toEqual({ status: "completed", error: null });
    expect(results.at(-1)).toMatchObject({ output: "v2" });
    expect(await run.prisma.externalEffect.count({ where: { runId, kind: "read" } })).toBe(0);
  },
);

it("lets webhook routines inspect native files without approval", async () => {
  const run = await startWorkerRun({
    steps: [
      { expect() {}, response: { type: "tool", id: "read", name: "ls", arguments: {} } },
      {
        expect(request) {
          expect(toolResult(request)).not.toContain("approval");
        },
        response: { type: "text", text: "Files inspected." },
      },
      { expect() {}, response: { type: "text", text: recap } },
    ],
  });
  cleanups.push(() => run.close());
  const runId = await run.send("Inspect files.");
  await run.prisma.run.update({
    where: { id: runId },
    data: { trigger: "webhook", requireToolApproval: true },
  });
  await run.continueRun(runId);
  run.model.assertComplete();
  expect(await run.prisma.externalEffect.count({ where: { runId, kind: "ls" } })).toBe(0);
});
