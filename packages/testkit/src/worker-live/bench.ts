import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { LocalWorkerProvider } from "../local-worker-provider.js";
import { quantiles, queryLog, settled } from "../worker-channel-tap.js";
import { call, finish, liveRun } from "./run.js";
import { type Live, type ProviderWrap, requireHeadroom } from "./session.js";

/** A memory series after each run, and its growth over the first and the last ten runs. */
function series(values: number[]) {
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    values: values.map(round),
    firstTenGrowth: round((values[9] ?? 0) - (values[0] ?? 0)),
    lastTenGrowth: round((values.at(-1) ?? 0) - (values.at(-10) ?? 0)),
  };
}

/**
 * Lane j: `trials` runs of five bash calls in each of three arms: P2's local runner in memory on
 * this machine, an E2B worker with no mount, and one with the private and shared volumes,
 * rotating which arm goes first. Timed at the
 * controller's side of the channel as P2's bench does. Cold boot is the provider's create plus
 * the guest's start, to its hello; the warm run is hello to the accepted end.
 */
export async function benchLive(live: Live, trials: number) {
  const toolsPerRun = 5;
  const arms = ["local_memory", "no_mounts", "two_mounts"] as const;
  const localRoot = await mkdtemp(path.join(tmpdir(), "rakazo-live-bench-"));
  type Arm = (typeof arms)[number];
  const steps = () =>
    Array.from({ length: trials }, () => [
      ...Array.from({ length: toolsPerRun }, (_, index) =>
        call(`sh-${index}`, "bash", { command: `echo ${index}` }),
      ),
      ...finish("Ran the commands"),
    ]).flat();
  const fixtures = new Map<
    Arm,
    {
      worker: Awaited<ReturnType<typeof liveRun>>;
      log: ReturnType<typeof queryLog>;
      ensures: number[];
    }
  >();
  for (const arm of arms) {
    const log = queryLog();
    const ensures: number[] = [];
    const timed: ProviderWrap = (provider) => ({
      describe: () => provider.describe(),
      destroy: (target, ctx) => provider.destroy(target, ctx),
      ensureVolume: (input, ctx) => provider.ensureVolume(input, ctx),
      connect: (target, capability) => provider.connect(target, capability),
      prepare: (ref, spec, ctx) => provider.prepare(ref, spec, ctx),
      async ensure(spec, ctx) {
        ensures.push(performance.now());
        return provider.ensure(spec, ctx);
      },
    });
    const worker = await liveRun(live, {
      steps: steps(),
      wrap: timed,
      prisma: log.wrap,
      files: arm === "two_mounts" ? { private: true, shared: true } : undefined,
      provider:
        arm === "local_memory"
          ? () => new LocalWorkerProvider({ mode: "memory", root: localRoot })
          : undefined,
    });
    fixtures.set(arm, { worker, log, ensures });
  }
  const samples: Array<Record<string, number | boolean | string>> = [];
  const perTool = new Map<
    Arm,
    {
      control: number[];
      queries: number[];
      queryMs: number[];
      relay: number[];
      grantToDone: number[];
    }
  >(
    arms.map((arm) => [arm, { control: [], queries: [], queryMs: [], relay: [], grantToDone: [] }]),
  );
  const rss: number[] = [];
  const heap: number[] = [];
  const buffers: number[] = [];
  const selectOneMs: number[] = [];
  const gc = (globalThis as { gc?: () => void }).gc;
  try {
    for (let trial = 0; trial < trials; trial++) {
      for (const arm of arms.map((_, index) => arms[(index + trial) % arms.length]!)) {
        const { worker, log, ensures } = fixtures.get(arm)!;
        requireHeadroom();
        worker.seen.length = 0;
        worker.connects.length = 0;
        ensures.length = 0;
        live.guestCommandStarts.length = 0;
        // The fixture's own records of earlier trials would read as controller growth.
        worker.run.model.requests.length = 0;
        log.queries.length = 0;
        const runId = await worker.run.send("Run the commands.");
        const started = performance.now();
        await worker.run.continueRun(runId);
        const runMs = performance.now() - started;
        const frames = worker.frames();
        const hello = frames.find((frame) => frame.kind === "worker.hello")!;
        const stop = frames.find((frame) => frame.from === "controller" && frame.type === "stop")!;
        const grants = settled(frames, "tool.call", "tool.grant");
        const records = settled(frames, "tool.done", "tool.recorded");
        const tools = perTool.get(arm)!;
        for (const [index, grant] of grants.entries()) {
          const record = records[index]!;
          const before = log.within(grant.from, grant.to);
          const after = log.within(record.from, record.to);
          tools.control.push(grant.to - grant.from + (record.to - record.from));
          tools.queries.push(before.count + after.count);
          tools.queryMs.push(before.ms + after.ms);
        }
        for (const model of settled(frames, "model.request", "model.end")) {
          tools.relay.push(model.to - model.from);
        }
        for (const grant of grants) {
          const done = frames.find(
            (frame) => frame.from === "guest" && frame.type === "tool.done" && frame.at > grant.to,
          );
          if (done) tools.grantToDone.push(done.at - grant.to);
        }
        gc?.();
        const memory = process.memoryUsage();
        rss.push(memory.rss / 1024 / 1024);
        heap.push(memory.heapUsed / 1024 / 1024);
        buffers.push(memory.arrayBuffers / 1024 / 1024);
        samples.push({
          arm,
          ok:
            (await worker.status(runId)) === "completed" &&
            grants.length === toolsPerRun &&
            records.length === toolsPerRun,
          ...(arm !== "local_memory" && {
            coldBootMs: hello.at - ensures[0]!,
            createMs: worker.connects[0]! - ensures[0]!,
            guestCommandStartMs: live.guestCommandStarts[0]!,
            guestBootMs: hello.at - worker.connects[0]! - live.guestCommandStarts[0]!,
          }),
          warmRunMs: stop.at - hello.at,
          controlMedianMs: quantiles(tools.control.slice(-grants.length)).p50 ?? Number.NaN,
          runMs,
        });
      }
    }
    for (const { worker } of fixtures.values()) worker.run.model.assertComplete();
    // What one round trip to this database costs on this machine, to read the control cost by.
    const calibration = fixtures.get("no_mounts")!.worker.run.prisma;
    for (let i = 0; i < 200; i++) {
      const at = performance.now();
      await calibration.$queryRaw`SELECT 1`;
      selectOneMs.push(performance.now() - at);
    }
  } finally {
    for (const { worker } of fixtures.values()) await worker.close();
    await rm(localRoot, { recursive: true, force: true });
  }
  const byArm = (arm: Arm, key: string) =>
    quantiles(samples.filter((sample) => sample.arm === arm).map((sample) => Number(sample[key])));
  const share = (arm: Arm) => {
    const tools = perTool.get(arm)!;
    const total = tools.control.reduce((sum, ms) => sum + ms, 0);
    return Math.round((tools.queryMs.reduce((sum, ms) => sum + ms, 0) / total) * 100) / 100;
  };
  return {
    trials,
    toolsPerRun,
    order: "each trial runs every arm, rotating which goes first",
    errors: samples.filter((sample) => !sample.ok).length,
    arms: Object.fromEntries(
      arms.map((arm) => [
        arm,
        {
          ...(arm !== "local_memory" && {
            coldBootMs: byArm(arm, "coldBootMs"),
            createMs: byArm(arm, "createMs"),
            guestCommandStartMs: byArm(arm, "guestCommandStartMs"),
            guestBootMs: byArm(arm, "guestBootMs"),
          }),
          warmRunMs: byArm(arm, "warmRunMs"),
          controlPerToolMs: quantiles(perTool.get(arm)!.control),
          queriesPerTool: quantiles(perTool.get(arm)!.queries),
          queryShareOfControl: share(arm),
          relayControllerMs: quantiles(perTool.get(arm)!.relay),
          grantToDoneMs: quantiles(perTool.get(arm)!.grantToDone),
        },
      ]),
    ),
    pgliteSelectOneMs: quantiles(selectOneMs),
    controlMedianByTrialMs: samples.map(
      (sample) => Math.round(Number(sample.controlMedianMs) * 10) / 10,
    ),
    memoryMiB: {
      gcBeforeEachSample: Boolean(gc),
      rss: series(rss),
      heapUsed: series(heap),
      arrayBuffers: series(buffers),
    },
  };
}
