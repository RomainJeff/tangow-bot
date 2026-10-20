import { readFileSync } from "node:fs";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { WORKER_LIMITS } from "@rakazo/adapters/runtime-worker";
import { fileTask, toolResult } from "../file-task.js";
import { startWorkerRun } from "../worker-run-fixture.js";
import { call, finish, liveRun } from "./run.js";
import { context, type Lane, sh, sha256 } from "./session.js";

export const laneA: Lane = {
  id: "a",
  issue: "tâche fichier identique à baseline",
  scenario:
    "#228's file task (write, refused overwrite, edit, missed edit, read, list) in process and in a real E2B worker on its private volume",
  passWhen: "The same final file and the same model-visible tool results in both arms",
  async run(live) {
    const inProcess = await (async () => {
      const seen: string[] = [];
      let file: string | undefined;
      const run = await startWorkerRun({
        steps: fileTask(seen, () => {
          file = readFileSync(
            path.join(run.provider.volumePath("bot_private"), "notes.md"),
            "utf8",
          );
        }),
        runtime: () => new PiAgentRuntime(),
      });
      try {
        const runId = await run.send("Write, edit, read and list a note.");
        await run.continueRun(runId);
        run.model.assertComplete();
        const results = (await run.runEntries(runId)).flatMap((entry) =>
          entry.type === "tool.result" ? [[entry.payload.output, entry.payload.isError]] : [],
        );
        return { seen, results, file };
      } finally {
        await run.close();
      }
    })();

    const seen: string[] = [];
    const worker = await liveRun(live, {
      steps: fileTask(seen, () => {}),
    });
    const files = live.volumeFiles();
    try {
      const runId = await worker.send("Write, edit, read and list a note.");
      await worker.completed(runId);
      const results = await worker.results(runId);
      const attempts = await worker.attempts(runId);
      const file = new TextDecoder().decode(
        await files.read(worker.volumes.private!, "notes.md", context("a")),
      );
      const sameSeen = JSON.stringify(seen) === JSON.stringify(inProcess.seen);
      const sameResults = JSON.stringify(results) === JSON.stringify(inProcess.results);
      return {
        pass:
          (await worker.status(runId)) === "completed" &&
          inProcess.file === "alpha\ngamma\n" &&
          file === inProcess.file &&
          sameSeen &&
          sameResults,
        observed: {
          inProcessFile: inProcess.file,
          workerFileReadFromVolumeAfterDestroy: file,
          sameModelVisibleResults: sameSeen,
          sameLoggedResults: sameResults,
          ...(sameSeen ? {} : { inProcessSeen: inProcess.seen, workerSeen: seen }),
          workerAttempts: attempts.map(({ workerState, stopPhase }) => ({
            workerState,
            stopPhase,
          })),
        },
      };
    } finally {
      await files.close();
      await worker.close();
    }
  },
};

const OUTPUT_LINES = 900_000;

export const laneF: Lane = {
  id: "f",
  issue: "sortie volumineuse conservée après destruction",
  scenario: `bash prints seq 1 ${OUTPUT_LINES} (over 5 MiB) in a worker with a private volume; the VM is destroyed at the end of the run`,
  passWhen:
    "The model sees at most 12,000 characters, the log at most 64 KiB, and the whole output is read back from the volume after the VM is gone",
  async run(live) {
    let shown = "";
    const worker = await liveRun(live, {
      steps: [
        call("big", "bash", { command: `seq 1 ${OUTPUT_LINES}` }),
        ...finish("Printed a long output", (request) => {
          shown = toolResult(request);
        }),
      ],
    });
    const files = live.volumeFiles();
    try {
      const expected = Array.from({ length: OUTPUT_LINES }, (_, i) => `${i + 1}\n`).join("");
      const runId = await worker.send("Print a long output.");
      await worker.completed(runId);
      const attempts = await worker.attempts(runId);
      const providerRefs = attempts.map((attempt) => attempt.workerProviderRef).filter(Boolean);
      const sandboxesLeft = (await live.census()).sandboxes;
      const logged = (await worker.run.runEntries(runId)).find(
        (entry) => entry.type === "tool.result" && entry.payload.callId === "big",
      );
      const loggedBytes = Buffer.byteLength(
        JSON.stringify(logged?.type === "tool.result" ? logged.payload.output : ""),
      );
      const spool = (await files.list(worker.volumes.private!, context("f"))).filter(
        (entry) => entry.kind === "file" && entry.path.startsWith(".rakazo/tool-output/"),
      );
      const content = spool[0]
        ? await files.read(worker.volumes.private!, spool[0].path, context("f"))
        : new Uint8Array();
      const pass =
        (await worker.status(runId)) === "completed" &&
        attempts.every((attempt) => attempt.workerState === "released") &&
        sandboxesLeft === 0 &&
        shown.length <= WORKER_LIMITS.localOutputModelChars + 512 &&
        loggedBytes <= WORKER_LIMITS.controllerResultBytes &&
        spool.length === 1 &&
        content.byteLength === Buffer.byteLength(expected) &&
        sha256(content) === sha256(expected);
      return {
        pass,
        observed: {
          outputBytes: Buffer.byteLength(expected),
          modelVisibleChars: shown.length,
          loggedResultBytes: loggedBytes,
          workerReleased: attempts.every((attempt) => attempt.workerState === "released"),
          workerSandboxes: providerRefs.length,
          sandboxesAliveWhenRead: sandboxesLeft,
          spoolFiles: spool.map((entry) => entry.path.replace(/[^/]+$/, "<id>")),
          spoolBytesReadAfterDestroy: content.byteLength,
          spoolMatchesOutput: sha256(content) === sha256(expected),
        },
      };
    } finally {
      await files.close();
      await worker.close();
    }
  },
};

export const laneI: Lane = {
  id: "i",
  issue: "run sans fichiers/computer",
  scenario:
    "A run whose bot has no computer; then a VM of the worker template, to check the guest user can write /workspace",
  passWhen:
    "The executor refuses the run before it routes it, with no attempt reaching a worker and no sandbox created; the sandbox user can write /workspace",
  async run(live) {
    const worker = await liveRun(live, { computer: "none", steps: [] });
    try {
      const before = await live.census();
      const runId = await worker.run.send("Run without a computer.");
      const refusal = await worker.run.continueRun(runId).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      const row = await worker.run.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        select: { status: true },
      });
      const attempts = await worker.attempts(runId);
      const after = await live.census();
      const vm = await live.vm({}, live.config.workerTemplate);
      const workspace = await sh(
        vm,
        "(echo x > /workspace/scratch.txt && echo writable) 2>/dev/null || echo read-only",
      );
      await vm.kill();
      return {
        pass:
          refusal === "Bot has no computer" &&
          attempts.every((attempt) => !attempt.workerProviderRef && !attempt.workerState) &&
          after.sandboxes === before.sandboxes &&
          worker.connects.length === 0 &&
          workspace === "writable",
        observed: {
          continueThrew: refusal,
          runStatusAfter: row.status,
          attemptsWithAWorker: attempts.filter((attempt) => attempt.workerState).length,
          sandboxesCreated: after.sandboxes - before.sandboxes,
          workspaceWritableBySandboxUser: workspace === "writable",
          note: "Every bot run needs a computer, and a bot with one is always offered the file tools, so the executor never derives a worker run without files: deriveRunNeeds' no-file case is covered offline.",
        },
      };
    } finally {
      await worker.close();
    }
  },
};
