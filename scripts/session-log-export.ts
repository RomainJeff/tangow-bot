/**
 * Writes a thread's main session and every session under it as JSONL files, one per session,
 * named by the session's id.
 *
 *   pnpm exec tsx scripts/session-log-export.ts <threadId> <directory>
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createDb } from "../packages/db/src/client.js";
import { exportThreadSessions } from "../packages/db/src/session-files.js";

async function main() {
  const [threadId, directory] = process.argv.slice(2);
  if (!threadId || !directory) {
    throw new Error("Usage: session-log-export.ts <threadId> <directory>");
  }
  if (!process.env.DATABASE_URL && existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  await mkdir(directory, { recursive: true });
  const { prisma, pool } = createDb(url);
  try {
    const sessions = await exportThreadSessions(prisma, threadId, (sessionId, lines) =>
      appendFile(path.join(directory, `${sessionId}.jsonl`), lines),
    );
    for (const sessionId of sessions) console.log(path.join(directory, `${sessionId}.jsonl`));
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
