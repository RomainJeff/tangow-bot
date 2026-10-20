/**
 * Moves one stopped computer's home from AgentHomeStore snapshots onto its E2B volumes, verifies
 * every file by hash and mode, then adopts the volumes. It refuses rather than write over
 * anything, and the AgentHomeStore copy stays as the original. Running it again after success
 * changes nothing; after an interruption it resumes the copy.
 *
 *   pnpm exec tsx scripts/migrate-home-to-volumes.ts --computer <id> --manifest <path>
 *   After stopping an interrupted move process, release its reservation with --clear-stale-move.
 *     [--dry-run] [--leave-unmapped] [--template <worker template>]
 *
 * The manifest path must not exist. The record is written there once the move creates anything,
 * even if it then stops on an error, and never on a dry run.
 *
 * It reaches each volume through a sandbox of the worker template that mounts it, destroyed at the
 * end. Reads DATABASE_URL, DATA_DIR for the AgentHomeStore, and E2B's own environment:
 * E2B_API_KEY, and E2B_DOMAIN or E2B_API_URL for a self-hosted E2B.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { E2BVolumeFiles, e2bVolumeSandbox } from "../packages/adapters/src/e2b-volume-files.js";
import { E2BWorkerProvider } from "../packages/adapters/src/e2b-worker.js";
import { LocalAgentHomeStore } from "../packages/adapters/src/home.js";
import { moveHomeToVolumes } from "../packages/adapters/src/home-volume-migration.js";
import { createWorkerLifecycle } from "../packages/adapters/src/worker-lifecycle.js";
import { createDb } from "../packages/db/src/client.js";

function options() {
  const { values } = parseArgs({
    options: {
      computer: { type: "string" },
      manifest: { type: "string" },
      "clear-stale-move": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "leave-unmapped": { type: "boolean", default: false },
      template: { type: "string", default: "rakazo-worker-pi" },
    },
  });
  const dryRun = values["dry-run"];
  if (!values.computer) throw new Error("--computer is required");
  if (!values.manifest && !dryRun && !values["clear-stale-move"])
    throw new Error("--manifest is required");
  return {
    clearStaleMove: values["clear-stale-move"],
    computerId: values.computer,
    manifestPath: values.manifest ?? null,
    dryRun,
    leaveUnmapped: values["leave-unmapped"],
    template: values.template,
  };
}

async function main() {
  const input = options();
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY is not set");
  const { prisma, pool } = createDb(url);
  const files = new E2BVolumeFiles(e2bVolumeSandbox({ template: input.template }));
  try {
    // The SDK reads E2B_DOMAIN or E2B_API_URL itself.
    const provider = new E2BWorkerProvider({ apiKey, template: input.template });
    const workers = createWorkerLifecycle({ prisma, provider });
    if (input.clearStaleMove) {
      await workers.clearStaleHomeMove(input.computerId);
      console.log("Interrupted home move reservation cleared; rerun the move to resume.");
      return;
    }
    const operationId = randomUUID();
    const report = await moveHomeToVolumes(
      {
        prisma,
        home: new LocalAgentHomeStore(process.env.DATA_DIR ?? "./data"),
        files,
        workers,
      },
      input,
      {
        operationId,
        traceId: operationId,
        spaceId: "operator",
        userId: "operator",
        signal: new AbortController().signal,
      },
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.outcome === "refused") process.exitCode = 1;
  } finally {
    // A sandbox left behind dies at its timeout: say so, without replacing the move's report.
    await files.close().catch((error: unknown) => {
      console.error(
        `Some volume sandboxes were not destroyed and stop at their one-hour timeout: ${error instanceof Error ? error.message : error}`,
      );
      process.exitCode = 1;
    });
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
