import { readFileSync } from "node:fs";
import path from "node:path";
import type { ComputerRef, WorkerSpec } from "@rakazo/adapter-kit";
import { DockerSandboxProvider, DockerWorkerProvider } from "@rakazo/adapters";
import { describe, expect, it } from "vitest";
import {
  docker,
  dockerWorkersEnabled,
  sandboxUser,
  useDockerSupervisor,
} from "./docker-worker.test-support.js";
import { toolResult } from "./file-task.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { call, finish } from "./worker-live/run.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const ctx = (id: string) => ({
  operationId: id,
  traceId: id,
  spaceId: "space-worker",
  userId: "user-worker",
  signal: new AbortController().signal,
});
const supervisor = useDockerSupervisor();
/** The run's own containers: other suites may share this Docker daemon. */
const containersOf = (attempts: Array<{ id: string }>) =>
  attempts
    .map((attempt) => docker("ps", "-aq", "--filter", `label=rakazo.attempt=${attempt.id}`))
    .join("");
const provider = () => supervisor.provider();

describe.skipIf(!dockerWorkersEnabled)("Docker workers", () => {
  it("runs pi-native through the real controller on a private and a shared volume", async () => {
    const seen: string[] = [];
    let run: Awaited<ReturnType<typeof startWorkerRun<DockerWorkerProvider>>>;
    let computer: ComputerRef;
    const step = (name: string, args: () => Record<string, unknown>): ModelEmulatorStep => ({
      expect: (request) => void seen.push(toolResult(request)),
      response: () => ({ type: "tool", id: `call-${name}`, name, arguments: args() }),
    });
    run = await startWorkerRun<DockerWorkerProvider>({
      provider,
      computerScope: "team",
      steps: [
        {
          async expect() {
            await run.sandbox.writeFile(
              computer,
              {
                path: `bots/${run.bot.id}/from-computer.txt`,
                content: Buffer.from("written on the computer"),
              },
              ctx("files"),
            );
          },
          response: {
            type: "tool",
            id: "call-bash",
            name: "bash",
            arguments: {
              command: "printf 'alpha\\n' > notes.md && id -u && pwd && cat from-computer.txt",
            },
          },
        },
        step("write", () => ({ path: "../../shared/team.txt", content: "team\n" })),
        step("message_user", () => ({ message: "Done." })),
        {
          expect: (request) => void seen.push(toolResult(request)),
          response: {
            type: "text",
            text: JSON.stringify({ version: 1, results: ["Wrote"], references: [] }),
          },
        },
      ],
    });
    try {
      computer = await run.startComputer();
      const runId = await run.send("Write the notes.");
      await run.continueRun(runId);
      run.model.assertComplete();
      expect(seen[0]).toBe(
        `${sandboxUser.uid}\n/workspace/bots/${run.bot.id}\nwritten on the computer`,
      );
      expect(seen[1]).toContain("Successfully wrote");
      const volumes = await run.prisma.volume.findMany();
      const ref = (kind: string) => volumes.find((volume) => volume.kind === kind)!.providerRef!;
      expect(ref("bot_private")).toMatch(/^rakazo-/);
      // Visible on the host, in DATA_DIR/volumes, after the worker is gone.
      const host = (kind: string, file: string) =>
        readFileSync(path.join(supervisor.dataDir, "volumes", ref(kind), file), "utf8");
      expect(host("bot_private", "notes.md")).toBe("alpha\n");
      expect(host("space_shared", "team.txt")).toBe("team\n");
      const attempts = await run.prisma.attempt.findMany({ where: { runId } });
      expect(attempts.map((attempt) => attempt.workerProviderKind)).toEqual(["docker-worker"]);
      expect(containersOf(attempts)).toBe("");
    } finally {
      await run.close();
    }
  }, 120_000);

  it("shows the Docker computer what a worker wrote, at the same paths", async () => {
    const sandbox = new DockerSandboxProvider(supervisor.url, supervisor.token);
    const run = await startWorkerRun<DockerWorkerProvider>({
      provider,
      sandbox,
      dataDir: supervisor.dataDir,
      computerScope: "team",
      steps: [
        call("write", "bash", {
          command:
            "printf 'worker\\n' > from-worker.txt && printf 'team\\n' > ../../shared/team.txt",
        }),
        ...finish("Wrote"),
      ],
    });
    let computer: ComputerRef | undefined;
    try {
      computer = await run.startComputer();
      const runId = await run.send("Write the files.");
      await run.continueRun(runId);
      run.model.assertComplete();
      const context = { ...ctx("computer"), spaceId: run.spaceId };
      const read = async (file: string) =>
        Buffer.from(await sandbox.readFile(computer!, file, context)).toString("utf8");
      expect(await read(`bots/${run.bot.id}/from-worker.txt`)).toBe("worker\n");
      expect(await read("shared/team.txt")).toBe("team\n");
      let output = "";
      for await (const event of sandbox.execute(
        computer,
        {
          argv: [
            "bash",
            "-c",
            `cat /workspace/bots/${run.bot.id}/from-worker.txt && readlink /home/rakazo/workspace && pwd`,
          ],
        },
        context,
      )) {
        if (event.type === "stdout") output += event.data;
      }
      expect(output).toBe("worker\n/workspace\n/workspace\n");
    } finally {
      if (computer) await sandbox.destroy(computer, { ...ctx("cleanup"), spaceId: run.spaceId });
      await run.close();
    }
  }, 180_000);

  it.each([
    ["the container dies right after it was created", "kill"],
    ["the create answer is lost after the container exists", "lose_answer"],
  ] as const)(
    "leaves no container and no lease when %s",
    async (_name, fault) => {
      let fired = false;
      class FaultyWorkers extends DockerWorkerProvider {
        override async ensure(workerSpec: WorkerSpec) {
          const created = await super.ensure(workerSpec);
          if (fired) return created;
          fired = true;
          if (fault === "kill") docker("kill", created.providerRef);
          else throw new Error("The answer to the create was lost");
          return created;
        }
      }
      const run = await startWorkerRun<DockerWorkerProvider>({
        provider: () =>
          new FaultyWorkers({
            supervisorUrl: supervisor.url,
            supervisorToken: supervisor.token,
            dataDir: supervisor.dataDir,
          }),
        computerScope: "team",
        steps: [call("ok", "bash", { command: "echo recovered" }), ...finish("Recovered")],
      });
      try {
        const runId = await run.send("Run after a fault.");
        await run.continueRun(runId).catch(() => undefined);
        if (fault === "lose_answer") {
          // Without its ref, the container is found by label once the ensure deadline has passed.
          await run.prisma.attempt.updateMany({
            where: { runId },
            data: { workerEnsureAt: new Date(Date.now() - 16 * 60 * 1000) },
          });
          await run.lifecycle.reconcile({ limit: 10 }, ctx("reconcile"));
        }
        for (let retry = 0; retry < 3; retry++) {
          const { status } = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
          if (status !== "queued") break;
          await run.continueRun(runId);
        }

        expect(await run.prisma.run.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({
          status: "completed",
        });
        const attempts = await run.prisma.attempt.findMany({ where: { runId } });
        // The faulted attempt, then the one that completed the run.
        expect(attempts.map((attempt) => attempt.workerState)).toEqual(["released", "released"]);
        expect(containersOf(attempts)).toBe("");
      } finally {
        await run.close();
      }
    },
    180_000,
  );
});
