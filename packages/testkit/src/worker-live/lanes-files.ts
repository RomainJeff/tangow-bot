import { readFileSync } from "node:fs";
import path from "node:path";
import { PiAgentRuntime } from "@rakazo/adapters";
import { WORKER_LIMITS } from "@rakazo/adapters/runtime-worker";
import { fileTask, nativeFileTask, toolResult } from "../file-task.js";
import { startWorkerRun } from "../worker-run-fixture.js";
import { call, finish, liveRun } from "./run.js";
import type { Lane } from "./session.js";
import { context, forward, sha256 } from "./session.js";

export const laneA: Lane = {
  id: "a",
  issue: "tâche fichier identique à baseline",
  scenario:
    "A file task through the in-process tools and Pi native write, edit, read and ls in an E2B worker on its private volume",
  passWhen: "The same final file content in both arms; tool names and result formats may differ",
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
      steps: nativeFileTask(seen, () => {}),
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
      return {
        pass:
          (await worker.status(runId)) === "completed" &&
          inProcess.file === "alpha\ngamma\n" &&
          file === inProcess.file,
        observed: {
          inProcessFile: inProcess.file,
          workerFileReadFromVolumeAfterDestroy: file,
          nativeToolResults: seen,
          loggedResultCount: results.length,
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
      const reportedPath = /it is in ([^\]\n]+)/.exec(shown)?.[1];
      const loggedBytes = Buffer.byteLength(
        JSON.stringify(logged?.type === "tool.result" ? logged.payload.output : ""),
      );
      const spool = (await files.list(worker.volumes.private!, context("f"))).filter(
        (entry) => entry.kind === "file" && /^\.rakazo-bash-[0-9a-f-]+\.log$/.test(entry.path),
      );
      const content = spool[0]
        ? await files.read(worker.volumes.private!, spool[0].path, context("f"))
        : new Uint8Array();
      const pass =
        (await worker.status(runId)) === "completed" &&
        attempts.every((attempt) => attempt.workerState === "released") &&
        sandboxesLeft === 0 &&
        shown.length <= WORKER_LIMITS.localOutputModelChars &&
        loggedBytes <= WORKER_LIMITS.controllerResultBytes &&
        spool.length === 1 &&
        reportedPath === `${worker.privateMount}/${spool[0]?.path}` &&
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
          reportedPathMatchesStoredFile:
            reportedPath === `${worker.privateMount}/${spool[0]?.path}`,
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
  issue: "run sans computer ni fichiers utilisateur",
  scenario:
    "A computerless bot calls an MCP tool served by the controller, then message_user, through a worker with no mounts",
  passWhen:
    "The run completes, the MCP tool ran once on the controller, no computer or volume is created, and worker.start grants no mounts",
  async run(live) {
    const mounts: unknown[] = [];
    const calls: string[] = [];
    let mcpResult = "";
    const worker = await liveRun(live, {
      computer: "none",
      tools: {
        describe: () => ({
          id: "worker-live-mcp",
          contractVersion: "1",
          adapterVersion: "1",
          capabilities: { discover: true, oauth: false, secretsBrokered: true },
        }),
        discoverTools: async () => [
          {
            name: "mcp_lookup",
            description: "Look up a record",
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
          },
        ],
        async *execute(request) {
          calls.push(request.tool);
          yield { type: "result", data: { found: "record-42" } };
        },
      },
      steps: [
        call("mcp", "mcp_lookup", {}),
        ...finish("Answered without a computer", (request) => {
          mcpResult = toolResult(request);
        }),
      ],
      wrap: (provider) =>
        forward(provider, {
          async ensure(spec, ctx) {
            mounts.push(spec.mounts);
            return provider.ensure(spec, ctx);
          },
        }),
    });
    try {
      const runId = await worker.send("Look up the record without a computer.");
      await worker.completed(runId);
      const computers = await worker.run.prisma.computer.count();
      const volumes = await worker.run.prisma.volume.count();
      const attempts = await worker.attempts(runId);
      return {
        pass:
          calls.length === 1 &&
          mcpResult.includes("record-42") &&
          computers === 0 &&
          volumes === 0 &&
          mounts.length === 1 &&
          JSON.stringify(mounts[0]) === "[]" &&
          attempts.every((attempt) => attempt.workerState === "released"),
        observed: {
          status: await worker.status(runId),
          mcpCalls: calls,
          mcpResultReachedModel: mcpResult.includes("record-42"),
          computers,
          volumes,
          mounts,
          workerAttempts: attempts.map(({ workerState }) => workerState),
        },
      };
    } finally {
      await worker.close();
    }
  },
};
