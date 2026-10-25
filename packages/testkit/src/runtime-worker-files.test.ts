import type { ComputerRef } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { toolResult } from "./file-task.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { afterPrivateText, startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const recap = JSON.stringify({ version: 1, results: ["Edited notes.md"], references: [] });

describe("a product run in a worker", () => {
  it("shares the bot's and the space's files with the computer, both ways", async () => {
    const seen: string[] = [];
    let run: Awaited<ReturnType<typeof startWorkerRun>>;
    let computer: ComputerRef;
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
    computer = await run.startComputer();
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

/** What a guest reports for a local tool it ran after the controller's grant. */
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
      afterPrivateText,
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
