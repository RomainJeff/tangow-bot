// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Operator command, never a cached Turbo task.
import { parseArgs } from "node:util";
import {
  inspectE2BDockerMigration,
  migrateE2BToDocker,
} from "../packages/adapters/src/e2b-docker-migration.js";
import { openE2BDockerSource } from "../packages/adapters/src/e2b-docker-source.js";
import { E2BWorkerProvider } from "../packages/adapters/src/e2b-worker.js";
import { createDb } from "../packages/db/src/client.js";

const { values } = parseArgs({
  options: { inspect: { type: "boolean" }, operation: { type: "string" } },
});

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const { prisma, pool } = createDb(url);
  const template = process.env.WORKER_TEMPLATE || "rakazo-worker-pi-native";
  try {
    if (values.inspect) {
      const inventory = await inspectE2BDockerMigration(prisma);
      console.log(
        JSON.stringify({
          computers: inventory.computers.length,
          volumes: inventory.volumes.length,
          blockers: inventory.blockers,
        }),
      );
      return;
    }
    if (!values.operation)
      throw new Error("--operation is required; run through tangow provider docker");
    if (process.getuid?.() !== 1000) throw new Error("Run migration as the application's uid 1000");
    const apiKey = process.env.E2B_API_KEY;
    if (!apiKey) throw new Error("E2B_API_KEY is required");
    const operationId = values.operation;
    const source = await openE2BDockerSource({ apiKey, template, operationId });
    try {
      const report = await migrateE2BToDocker(
        {
          prisma,
          dataDir: process.env.DATA_DIR ?? "/data",
          source: source.source,
          workers: new E2BWorkerProvider({ apiKey, template }),
          destroyComputer: source.destroyComputer,
        },
        operationId,
        {
          operationId,
          traceId: operationId,
          spaceId: "operator",
          userId: "operator",
          signal: new AbortController().signal,
        },
      );
      console.log(JSON.stringify(report));
    } finally {
      await source.close();
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Migration failed");
  process.exitCode = 1;
});
