import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import type { PrismaClient } from "@rakazo/db";
import { openPgliteDatabase } from "@rakazo/db/pglite.test-support";
import { FakeWorkerProvider } from "./fake-worker-provider.js";
import { allFiles, workerFixture } from "./worker-fixture.test-support.js";
import { createWorkerLifecycle } from "./worker-lifecycle.js";

const { values } = parseArgs({
  options: {
    plans: { type: "string", default: "200" },
    cycles: { type: "string", default: "200" },
    warmup: { type: "string", default: "10" },
    out: { type: "string" },
  },
});
const plans = Number(values.plans);
const cycles = Number(values.cycles);
const warmup = Number(values.warmup);
for (const [name, value] of Object.entries({ plans, cycles, warmup })) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be an integer >= 0`);
}
if (!values.out) throw new Error("--out <receipt.json> is required");

const BUDGET_P95_MS = 100;

function summary(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
}

async function main() {
  const database = await openPgliteDatabase();
  try {
    let queries = 0;
    const counted = database.prisma.$extends({
      query: {
        $allOperations({ args, query }) {
          queries += 1;
          return query(args);
        },
      },
    }) as unknown as PrismaClient;
    const fixture = workerFixture(database.prisma);
    await fixture.seedOwner();
    const fake = new FakeWorkerProvider();
    const workers = createWorkerLifecycle({ prisma: counted, provider: fake });

    const { bot, privateVolume, sharedVolume } = await fixture.migratedBot();
    const planned = await fixture.seedAttempt((await fixture.seedRun(bot)).id);
    const expectedVolumes = [privateVolume.id, sharedVolume.id];

    const timePlan = async () => {
      const before = queries;
      const started = performance.now();
      const plan = await workers.plan({ attemptId: planned.id, needs: allFiles });
      const ms = performance.now() - started;
      assert.equal(plan.mode, "worker");
      assert.deepEqual(
        plan.mode === "worker" && plan.volumes.map((grant) => grant.volumeId),
        expectedVolumes,
      );
      return { ms, queries: queries - before };
    };
    const warmupPlans = [];
    for (let i = 0; i < warmup; i++) warmupPlans.push(await timePlan());
    const planSamples = [];
    for (let i = 0; i < plans; i++) planSamples.push(await timePlan());

    const attempts = [];
    for (let i = 0; i < warmup + cycles; i++) {
      attempts.push((await fixture.seedAttempt((await fixture.seedRun(bot)).id)).id);
    }
    const timeCycle = async (attemptId: string) => {
      const launch = await fixture.launchFor(workers, attemptId, allFiles);
      const before = queries;
      const started = performance.now();
      await workers.start(launch, fixture.context);
      await workers.release(attemptId, fixture.context);
      const ms = performance.now() - started;
      assert.equal(await fixture.workerStateOf(attemptId), "released");
      return { ms, queries: queries - before };
    };
    const warmupCycles = [];
    for (const attemptId of attempts.slice(0, warmup))
      warmupCycles.push(await timeCycle(attemptId));
    const cycleSamples = [];
    for (const attemptId of attempts.slice(warmup)) cycleSamples.push(await timeCycle(attemptId));
    assert.deepEqual(
      [await fixture.writerOf(privateVolume.id), await fixture.writerOf(sharedVolume.id)],
      [null, null],
    );
    assert.equal(fake.live.size, 0);

    const planQueryCounts = [...new Set(planSamples.map((sample) => sample.queries))];
    const planSummary = summary(planSamples.map((sample) => sample.ms));
    const receipt = {
      generatedAt: new Date().toISOString(),
      host: { platform: platform(), arch: arch(), cpus: cpus().length, node: process.version },
      database: "PGlite in memory over the wire protocol, all repository migrations applied",
      provider: "FakeWorkerProvider (in memory)",
      warmup,
      budget: { planP95Ms: BUDGET_P95_MS },
      plan: {
        ...planSummary,
        queriesPerPlan: planQueryCounts,
        withinBudget: planSummary.p95 !== undefined && planSummary.p95 < BUDGET_P95_MS,
        samplesMs: planSamples.map((sample) => sample.ms),
        warmupMs: warmupPlans.map((sample) => sample.ms),
      },
      startRelease: {
        ...summary(cycleSamples.map((sample) => sample.ms)),
        queriesPerCycle: [...new Set(cycleSamples.map((sample) => sample.queries))],
        samplesMs: cycleSamples.map((sample) => sample.ms),
        warmupMs: warmupCycles.map((sample) => sample.ms),
      },
    };
    await mkdir(dirname(values.out!), { recursive: true });
    await writeFile(values.out!, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        plan: { ...planSummary, queriesPerPlan: planQueryCounts },
        startRelease: summary(cycleSamples.map((sample) => sample.ms)),
      })}\n`,
    );
  } finally {
    await database.close();
  }
}

await main();
