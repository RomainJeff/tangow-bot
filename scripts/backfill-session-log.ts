/**
 * Brings a database to the session log: applies the migrations, and when the one that drops the
 * legacy messages table refuses because threads still hold messages, writes every such thread to
 * its main session and applies it again. Running it twice changes nothing.
 *
 *   pnpm exec tsx scripts/backfill-session-log.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  backfillThread,
  hasLegacyMessages,
  threadsToBackfill,
} from "../packages/db/src/backfill-session-log.js";
import type { PrismaClient } from "../packages/db/src/client.js";
import { createDb } from "../packages/db/src/client.js";

const DROP_MIGRATION = "20261012000000_drop_messages";
const BATCH = 100;

function prismaCli(...args: string[]): boolean {
  const run = spawnSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", ...args], {
    stdio: "inherit",
  });
  return run.status === 0;
}

/** The drop migration ran and stopped at its guard, so the threads it named wait for the backfill. */
async function dropWaitsForBackfill(prisma: PrismaClient): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ failed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM _prisma_migrations
      WHERE migration_name = ${DROP_MIGRATION} AND finished_at IS NULL AND rolled_back_at IS NULL
    ) AS failed`;
  return row?.failed === true && (await hasLegacyMessages(prisma));
}

async function backfillAll(prisma: PrismaClient): Promise<string[]> {
  const started = performance.now();
  const failed: string[] = [];
  let done = 0;
  let messages = 0;
  let after = "";
  for (;;) {
    const threads = await threadsToBackfill(prisma, BATCH, after);
    if (threads.length === 0) break;
    for (const threadId of threads) {
      const threadStarted = performance.now();
      try {
        const result = await backfillThread(prisma, threadId);
        done += 1;
        if (result.outcome === "backfilled") {
          messages += result.messages;
          const ms = Math.round(performance.now() - threadStarted);
          console.log(
            `thread ${threadId}: ${result.messages} messages, ${result.entries} entries, ${ms} ms`,
          );
        }
      } catch (error) {
        failed.push(threadId);
        console.error(`thread ${threadId} failed:`, error);
      }
    }
    after = threads.at(-1)!;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`backfilled ${done} threads, ${messages} messages, in ${seconds} s`);
  return failed;
}

async function main() {
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { prisma, pool } = createDb(url);
  try {
    if (prismaCli("migrate", "deploy")) return;
    if (!(await dropWaitsForBackfill(prisma))) throw new Error("prisma migrate deploy failed");
    console.log("The messages table waits for its threads to be backfilled.");
    const failed = await backfillAll(prisma);
    if (failed.length > 0) {
      throw new Error(`${failed.length} threads could not be backfilled: ${failed.join(", ")}`);
    }
    if (!prismaCli("migrate", "resolve", "--rolled-back", DROP_MIGRATION)) {
      throw new Error(`prisma migrate resolve --rolled-back ${DROP_MIGRATION} failed`);
    }
    if (!prismaCli("migrate", "deploy")) throw new Error("prisma migrate deploy failed");
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
