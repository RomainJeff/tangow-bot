/**
 * Moves every idle Docker computer's home onto its volumes, by renaming its directories under
 * `DATA_DIR`. The Compose `migrate` service runs it after the migrations, before the API and the
 * worker start. A computer still running or controlled is left for the idle job, which moves it
 * when it suspends. A home that conflicts with its volume is logged with its computer id and
 * skipped, and a move that stopped partway resumes. Any other failure (storage the move cannot
 * write, homes and volumes on different filesystems, the database) exits non-zero. Then each
 * space's legacy user skills are copied once to its shared volume. Running it twice changes nothing.
 *
 *   pnpm exec tsx scripts/migrate-docker-homes.ts
 *
 * Reads DATABASE_URL, DATA_DIR and SANDBOX_PROVIDER. Another provider than docker has nothing to move.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  listDeferredDockerHomes,
  moveIdleDockerHomes,
} from "../packages/adapters/src/docker-home-migration.js";
import { DockerWorkerProvider } from "../packages/adapters/src/docker-worker.js";
import { createWorkerLifecycle } from "../packages/adapters/src/worker-lifecycle.js";
import { createDb } from "../packages/db/src/client.js";

async function main() {
  const { values } = parseArgs({ options: { inspect: { type: "boolean" } } });
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  if ((process.env.SANDBOX_PROVIDER?.trim() || "docker") !== "docker") return;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const dataDir = process.env.DATA_DIR ?? "./data";
  const { prisma, pool } = createDb(url);
  try {
    if (values.inspect) {
      console.log(JSON.stringify({ deferred: await listDeferredDockerHomes({ prisma, dataDir }) }));
      return;
    }
    // Only its volume methods run here, on DATA_DIR: the move never calls the supervisor.
    const provider = new DockerWorkerProvider({
      supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
      supervisorToken: process.env.SANDBOX_SUPERVISOR_TOKEN ?? "",
      dataDir,
    });
    const workers = createWorkerLifecycle({ prisma, provider });
    const { adopted, deferred } = await moveIdleDockerHomes(
      { prisma, workers, dataDir },
      {
        operationId: "migrate.docker-homes",
        traceId: "migrate.docker-homes",
        spaceId: "operator",
        userId: "operator",
        signal: new AbortController().signal,
      },
    );
    if (adopted || deferred) {
      console.log(
        `Docker homes on volumes: ${adopted} moved, ${deferred} left for when their computer suspends.`,
      );
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
