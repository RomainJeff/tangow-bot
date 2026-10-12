/**
 * Brings a database to the session log: applies the migrations, and when the one that drops the
 * legacy messages table refuses because messages are not in the log yet, writes them to their
 * threads' main sessions and applies it again. Running it twice changes nothing.
 *
 *   pnpm exec tsx scripts/backfill-session-log.ts
 *     [--rebuild-from-messages <thread-id> | --rebuild-from-messages --all]
 *     [--skip <thread-id>[,<thread-id>...]]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  BackfillRefused,
  backfillThread,
  hasLegacyMessages,
  threadsToBackfill,
} from "../packages/db/src/backfill-session-log.js";
import type { PrismaClient } from "../packages/db/src/client.js";
import { createDb } from "../packages/db/src/client.js";

const DROP_MIGRATION = "20261012000000_drop_messages";
const BATCH = 100;
/** Rounds of backfill and migration while messages keep arriving between the two. */
const ROUNDS = 3;

type Options = { rebuild: "all" | ReadonlySet<string>; skip: ReadonlySet<string> };

function options(argv = process.argv.slice(2)): Options {
  let rebuild: Options["rebuild"] = new Set<string>();
  const skip = new Set<string>();
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    const ids = value?.split(",").filter(Boolean) ?? [];
    if (flag === "--rebuild-from-messages" && value === "--all") rebuild = "all";
    else if (flag === "--rebuild-from-messages" && ids.length > 0 && rebuild !== "all") {
      rebuild = new Set([...rebuild, ...ids]);
    } else if (flag === "--skip" && ids.length > 0) for (const id of ids) skip.add(id);
    else throw new Error(`Unexpected arguments: ${argv.slice(index).join(" ")}`);
  }
  return { rebuild, skip };
}

function prismaCli(...args: string[]): boolean {
  const run = spawnSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", ...args], {
    stdio: "inherit",
  });
  return run.status === 0;
}

/** The drop migration ran and stopped at its guard, so the messages it named wait for the backfill. */
async function dropWaitsForBackfill(prisma: PrismaClient): Promise<boolean> {
  const [row] = await prisma.$queryRaw<Array<{ failed: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM _prisma_migrations
      WHERE migration_name = ${DROP_MIGRATION} AND finished_at IS NULL AND rolled_back_at IS NULL
    ) AS failed`;
  return row?.failed === true && (await hasLegacyMessages(prisma));
}

type Round = { appended: number; refused: string[]; failed: string[]; skipped: string[] };

async function backfillAll(prisma: PrismaClient, { rebuild, skip }: Options): Promise<Round> {
  const started = performance.now();
  const round: Round = { appended: 0, refused: [], failed: [], skipped: [] };
  let threads = 0;
  let after = "";
  for (;;) {
    const batch = await threadsToBackfill(prisma, BATCH, after);
    if (batch.length === 0) break;
    for (const threadId of batch) {
      if (skip.has(threadId)) {
        round.skipped.push(threadId);
        continue;
      }
      const threadStarted = performance.now();
      try {
        const result = await backfillThread(prisma, threadId, {
          rebuild: rebuild === "all" || rebuild.has(threadId),
        });
        if (result.outcome === "skipped") continue;
        threads += 1;
        round.appended += result.messages;
        const ms = Math.round(performance.now() - threadStarted);
        console.log(
          `thread ${threadId} ${result.outcome}: ${result.messages} messages, ${result.entries} entries, ${ms} ms`,
        );
      } catch (error) {
        if (error instanceof BackfillRefused) {
          round.refused.push(threadId);
          console.error(error.message);
        } else {
          round.failed.push(threadId);
          console.error(`thread ${threadId} failed:`, error);
        }
      }
    }
    after = batch.at(-1)!;
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`backfilled ${threads} threads, ${round.appended} messages, in ${seconds} s`);
  return round;
}

function stopped({ refused, failed, skipped }: Round): string | undefined {
  const lines = [
    refused.length > 0 &&
      `${refused.length} threads hold messages older than their log (rebuild them with --rebuild-from-messages): ${refused.join(", ")}`,
    failed.length > 0 && `${failed.length} threads could not be backfilled: ${failed.join(", ")}`,
    skipped.length > 0 && `${skipped.length} threads were skipped: ${skipped.join(", ")}`,
  ].filter(Boolean);
  return lines.length > 0
    ? `${lines.join("\n")}\nThe messages table stays until every message is in the log; see "Session log migration" in docs/self-host.md.`
    : undefined;
}

async function migrate(prisma: PrismaClient, chosen: Options) {
  if (prismaCli("migrate", "deploy")) {
    if (chosen.rebuild === "all" || chosen.rebuild.size > 0) {
      throw new Error("The messages table is gone, so there is nothing to rebuild from.");
    }
    return;
  }
  for (let round = 1; await dropWaitsForBackfill(prisma); round += 1) {
    console.log("The messages table waits for its messages to be in the session log.");
    const result = await backfillAll(
      prisma,
      round === 1 ? chosen : { ...chosen, rebuild: new Set() },
    );
    // Rolled back, the database stays one the previous release starts on, and a rerun starts clean.
    if (!prismaCli("migrate", "resolve", "--rolled-back", DROP_MIGRATION)) {
      throw new Error(`prisma migrate resolve --rolled-back ${DROP_MIGRATION} failed`);
    }
    const reason = stopped(result);
    if (reason) throw new Error(reason);
    if (prismaCli("migrate", "deploy")) return;
    if (round === ROUNDS) break;
  }
  throw new Error("prisma migrate deploy failed");
}

async function main() {
  const chosen = options();
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { prisma, pool } = createDb(url);
  try {
    await migrate(prisma, chosen);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
