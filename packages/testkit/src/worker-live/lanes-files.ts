import { PiAgentRuntime } from "@rakazo/adapters";
import { WORKER_LIMITS } from "@rakazo/adapters/runtime-worker";
import { fileTask, toolResult } from "../file-task.js";
import { startWorkerRun } from "../worker-run-fixture.js";
import { call, finish, liveRun } from "./run.js";
import { context, type Lane, sha256 } from "./session.js";

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
          file = [...run.sandbox.boxes.values()]
            .map((box) => box.files.get("notes.md"))
            .filter((stored) => stored !== undefined)
            .map((stored) => Buffer.from(stored.content).toString())[0];
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
      files: { private: true, shared: false },
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
      files: { private: true, shared: false },
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
  scenario: "A run that needs no files and no computer, as an MCP-only run",
  passWhen:
    "The worker starts with no mount, its guest sees no network file system, and the run completes",
  async run(live) {
    let shown = "";
    const worker = await liveRun(live, {
      steps: [
        call("m1", "bash", { command: "awk '$3 ~ /^nfs/' /proc/mounts | wc -l; pwd" }),
        ...finish("Ran without files", (request) => {
          shown = toolResult(request);
        }),
      ],
    });
    try {
      const runId = await worker.send("Run without files.");
      await worker.completed(runId);
      const start = worker.seen
        .filter((frame) => frame.from === "controller")
        .map(
          (frame) =>
            JSON.parse(Buffer.from(frame.frame).toString()) as {
              kind: string;
              workspace?: unknown;
              computer?: string;
            },
        )
        .find((message) => message.kind === "worker.start");
      const lines = shown
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      return {
        pass:
          (await worker.status(runId)) === "completed" &&
          JSON.stringify(start?.workspace) === JSON.stringify({ cwd: "/workspace", mounts: [] }) &&
          start?.computer === "none" &&
          lines[0] === "0" &&
          lines[1] === "/workspace",
        observed: {
          workspace: start?.workspace,
          computer: start?.computer,
          nfsMountsInGuest: lines[0],
          guestCwd: lines[1],
        },
      };
    } finally {
      await worker.close();
    }
  },
};
