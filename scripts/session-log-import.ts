/**
 * Reads the JSONL files `session-log-export.ts` wrote into a thread whose session is still empty:
 * the exported main session becomes the thread's, and each session under it a new one under its
 * imported parent.
 *
 *   pnpm exec tsx scripts/session-log-import.ts <directory> <threadId>
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createDb } from "../packages/db/src/client.js";
import { importThreadSessions } from "../packages/db/src/session-files.js";

async function main() {
  const [directory, threadId] = process.argv.slice(2);
  if (!directory || !threadId) {
    throw new Error("Usage: session-log-import.ts <directory> <threadId>");
  }
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
  const sessions = await Promise.all(
    files.map(async (name) => ({
      sessionId: path.basename(name, ".jsonl"),
      jsonl: await readFile(path.join(directory, name), "utf8"),
    })),
  );
  const { prisma, pool } = createDb(url);
  try {
    const imported = await importThreadSessions(prisma, threadId, sessions);
    console.log(`imported ${imported.entries} entries in ${imported.sessions} sessions`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
