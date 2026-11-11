import { performance } from "node:perf_hooks";
import { cancelRunsInTransaction } from "@tangow/db";
import { Sandbox } from "e2b";
import { call, finish, liveRun } from "./run.js";
import { context, type Lane, type Live } from "./session.js";

const MARKER = "p5-started";
/** Appends one marker line, then sleeps past the lane, so only an interruption ends it. */
const SLOW = `printf 'started\\n' >> ${MARKER}; sleep 300`;
const INTERRUPTED =
  "The bash call was interrupted, so its outcome is unknown. It was not replayed; check the state before retrying.";

type Worker = Awaited<ReturnType<typeof liveRun>>;

const settled = (running: Promise<unknown>) =>
  running.then(
    () => "completed",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

/** The run's bash calls and results, in the session's order, which history replays. */
async function bashLog(worker: Worker, runId: string) {
  const entries = (await worker.run.runEntries(runId)).toSorted((a, b) => a.seq - b.seq);
  const ids = new Set(
    entries.flatMap((entry) =>
      entry.type === "tool.call" && entry.payload.name === "bash" ? [entry.payload.callId] : [],
    ),
  );
  return entries.flatMap((entry) =>
    entry.type === "tool.call" && ids.has(entry.payload.callId)
      ? [`call ${entry.payload.callId}`]
      : entry.type === "tool.result" && ids.has(entry.payload.callId)
        ? [`result ${entry.payload.callId} ${entry.payload.output}`]
        : [],
  );
}

/** The marker on the private volume, read from a second VM, so it outlives the worker. */
function markerReader(live: Live, worker: Worker, lane: string) {
  const files = live.volumeFiles();
  const volume = worker.volumes.private!;
  const listed = async () =>
    (await files.list(volume, context(lane))).some((entry) => entry.path === MARKER);
  const read = async () =>
    new TextDecoder().decode(await files.read(volume, MARKER, context(lane)));
  return {
    read,
    /** Opens the reader's VM before the run, so the poll sees the marker as soon as it lands. */
    warm: listed,
    async written() {
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const text = (await listed()) ? await read() : "";
        if (text) return text;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`The guest never wrote ${MARKER}`);
    },
    close: () => files.close(),
  };
}

/** Removes the session's resources and passes only if none was left running or undeletable. */
async function cleanedUp(live: Live) {
  const cleanup = await live.sweep();
  return {
    cleanup,
    clean: cleanup.killed === 0 && cleanup.left.sandboxes === 0 && cleanup.left.volumes === 0,
  };
}

export const laneNativeKillBash: Lane = {
  id: "native-kill-bash",
  issue: "P5 native call durable across a worker VM that dies mid-command",
  scenario:
    "A native Pi bash appends a marker and sleeps; once a second VM sees the marker on the private volume, the lane kills the worker VM through E2B, then the run continues on a new attempt",
  passWhen:
    "The call is in the run log before the kill, the next attempt's first model request shows it closed as interrupted with an unknown outcome, the marker holds one line, the call is never replayed, and no owned sandbox or volume is left",
  async run(live) {
    let retried = "";
    const worker = await liveRun(live, {
      steps: [
        call("slow", "bash", { command: SLOW }),
        ...finish("Reported the interrupted command", (request) => {
          retried = JSON.stringify(request.messages);
        }),
      ],
    });
    const marker = markerReader(live, worker, "native-kill-bash");
    let observed: Record<string, unknown>;
    let pass: boolean;
    try {
      await marker.warm();
      const runId = await worker.run.send("Append the marker, then wait.");
      const first = settled(worker.run.continueRun(runId));
      const markerBeforeKill = await marker.written();
      const loggedBeforeKill = await bashLog(worker, runId);
      const [attempt] = await worker.attempts(runId);
      const killed = await Sandbox.kill(attempt!.workerProviderRef!, live.connection);
      const firstContinue = await first;
      const statusAfterKill = await worker.status(runId);
      let continues = 0;
      while ((await worker.status(runId)) === "queued" && continues < 3) {
        continues += 1;
        await worker.run.continueRun(runId);
      }
      await worker.completed(runId);
      const log = await bashLog(worker, runId);
      const markerAfter = await marker.read();
      const attempts = (await worker.attempts(runId)).map(({ workerState }) => workerState);
      observed = {
        markerBeforeKill,
        loggedBeforeKill,
        killed,
        firstContinue,
        statusAfterKill,
        continues,
        retriedRequestShowsInterrupted: retried.includes(INTERRUPTED),
        log,
        markerAfter,
        attempts,
      };
      pass =
        markerBeforeKill === "started\n" &&
        JSON.stringify(loggedBeforeKill) === JSON.stringify(["call slow"]) &&
        killed &&
        statusAfterKill === "queued" &&
        retried.includes(INTERRUPTED) &&
        retried.includes(MARKER) &&
        JSON.stringify(log) === JSON.stringify(["call slow", `result slow ${INTERRUPTED}`]) &&
        markerAfter === "started\n" &&
        JSON.stringify(attempts) === JSON.stringify(["released", "released"]);
    } finally {
      await marker.close();
      await worker.close();
    }
    const { cleanup, clean } = await cleanedUp(live);
    return { pass: pass && clean, observed: { ...observed, cleanup } };
  },
};

export const laneNativeCancel: Lane = {
  id: "native-cancel",
  issue: "P5 native work kept across a user cancel",
  scenario:
    "A native Pi bash finishes, a second one appends a marker and sleeps; once a second VM sees the marker, the run is cancelled as the stop button does, then continued again",
  passWhen:
    "The run ends cancelled with the finished call and its result in the log and the cut call logged without a result, no model request follows the cancel, a later continue takes no attempt, the marker holds one line, and no owned sandbox or volume is left",
  async run(live) {
    const worker = await liveRun(live, {
      steps: [
        call("done", "bash", { command: "echo done-ok" }),
        call("cut", "bash", { command: SLOW }),
      ],
    });
    const marker = markerReader(live, worker, "native-cancel");
    let observed: Record<string, unknown>;
    let pass: boolean;
    try {
      await marker.warm();
      const runId = await worker.run.send("Work, then wait.");
      const working = settled(worker.run.continueRun(runId));
      const markerBeforeCancel = await marker.written();
      const { taskId } = await worker.run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
      const cancelledAt = performance.now();
      await worker.run.prisma.$transaction((tx) =>
        cancelRunsInTransaction(tx, [{ id: runId, taskId }], new Date(), worker.run.userId),
      );
      const firstContinue = await working;
      // The attempt sees the cancel at its next lease heartbeat, at most a minute later.
      const stoppedAfterMs = Math.round(performance.now() - cancelledAt);
      const logAfterCancel = await bashLog(worker, runId);
      await worker.run.continueRun(runId);
      worker.run.model.assertComplete();
      const log = await bashLog(worker, runId);
      const markerAfter = await marker.read();
      const attempts = (await worker.attempts(runId)).map(({ workerState }) => workerState);
      const status = await worker.status(runId);
      observed = {
        markerBeforeCancel,
        firstContinue,
        stoppedAfterMs,
        status,
        logAfterCancel,
        logAfterSecondContinue: log,
        markerAfter,
        attempts,
      };
      pass =
        markerBeforeCancel === "started\n" &&
        status === "cancelled" &&
        JSON.stringify(logAfterCancel) ===
          JSON.stringify(["call done", "result done done-ok\n", "call cut"]) &&
        JSON.stringify(log) === JSON.stringify(logAfterCancel) &&
        markerAfter === "started\n" &&
        JSON.stringify(attempts) === JSON.stringify(["released"]);
    } finally {
      await marker.close();
      await worker.close();
    }
    const { cleanup, clean } = await cleanedUp(live);
    return { pass: pass && clean, observed: { ...observed, cleanup } };
  },
};
