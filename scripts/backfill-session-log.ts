/**
 * Brings a database to the session log: applies the migrations, then, while the legacy messages
 * table is still there, moves every message into the log and drops the table, all in one round
 * that leaves nothing behind when a thread refuses or fails. Running it twice changes nothing.
 *
 *   pnpm exec tsx scripts/backfill-session-log.ts
 *     [--rebuild-from-messages <thread-id>[,<thread-id>...] | --rebuild-from-messages --all]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { moveLegacyMessages } from "../packages/db/src/backfill-session-log.js";
import { createDb } from "../packages/db/src/client.js";

function rebuildOption(argv = process.argv.slice(2)): "all" | Set<string> {
  const [flag, value, ...rest] = argv;
  if (flag === undefined) return new Set();
  if (flag !== "--rebuild-from-messages" || !value || rest.length > 0) {
    throw new Error(`Unexpected arguments: ${argv.join(" ")}`);
  }
  return value === "--all" ? "all" : new Set(value.split(",").filter(Boolean));
}

async function main() {
  const rebuild = rebuildOption();
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const deploy = spawnSync(
    "pnpm",
    ["--filter", "@tangow/db", "exec", "prisma", "migrate", "deploy"],
    {
      stdio: "inherit",
    },
  );
  if (deploy.status !== 0) throw new Error("prisma migrate deploy failed");
  const { prisma, pool } = createDb(url);
  try {
    await moveLegacyMessages(prisma, { rebuild, log: console.log });
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
