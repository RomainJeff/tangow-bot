/**
 * readTail on a long session against a real Postgres, measured against the session log's budgets.
 * Seeds two 200 000 entry sessions shaped like the plan's prototype (a rewind of depth 40 every
 * 5 000 entries, payloads of about 400 characters), one with a compaction every 500 entries and one
 * with none, then times five reads of each. Run against a migrated, disposable database:
 *
 *   DATABASE_URL=postgres://... pnpm exec tsx packages/adapters/src/session-log/read-tail.perf.ts
 */
import { SessionId } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";
import { PostgresSessionLog } from "./postgres.js";

const ENTRIES = 200_000;
const COMPACT_EVERY = 500;
const REWIND_EVERY = 5_000;
const REWIND_DEPTH = 40;
const RUNS = 5;
const MEDIAN_BUDGET_MS = 15;
const WORST_CASE_BUDGET_MS = 500;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must name a migrated, disposable database");
const { prisma, pool } = createDb(url, { poolMax: 2 });
const log = new PostgresSessionLog(prisma);
const print = (line: string) => process.stdout.write(`${line}\n`);

async function seedSession(tag: string, compact: boolean): Promise<SessionId> {
  const bot = await prisma.bot.create({
    data: { spaceId: "perf-space", userId: "perf-user", name: tag, color: "#00C46A" },
  });
  const thread = await prisma.thread.create({
    data: { spaceId: "perf-space", userId: "perf-user", botId: bot.id },
  });
  const sessionId = SessionId.parse(thread.sessionId);
  const started = performance.now();
  await prisma.$executeRaw`
    INSERT INTO session_entries (id, "sessionId", seq, "parentId", type, payload, "botId", "runId", "createdAt")
    SELECT ${tag} || '-' || s, ${sessionId}, s,
      CASE WHEN s = 0 THEN NULL
           WHEN s % ${REWIND_EVERY} = 0 THEN ${tag} || '-' || (s - ${REWIND_DEPTH})
           ELSE ${tag} || '-' || (s - 1) END,
      kind,
      CASE kind
        WHEN 'rewind' THEN jsonb_build_object('reason', 'perf')
        WHEN 'compaction' THEN jsonb_build_object('summary', body, 'coveredUpToSeq', s - 1)
        WHEN 'user.message' THEN jsonb_build_object('blocks', jsonb_build_array(jsonb_build_object('kind', 'text', 'text', body)), 'source', 'app')
        WHEN 'assistant.text' THEN jsonb_build_object('blocks', jsonb_build_array(jsonb_build_object('kind', 'text', 'text', body)))
        WHEN 'tool.call' THEN jsonb_build_object('callId', 'call-' || s, 'name', 'web_search', 'input', body)
        ELSE jsonb_build_object('callId', 'call-' || (s - 1), 'output', body, 'isError', false, 'artifactIds', jsonb_build_array())
      END,
      CASE WHEN kind IN ('assistant.text', 'tool.call', 'tool.result') THEN ${bot.id} END,
      CASE WHEN kind IN ('assistant.text', 'tool.call', 'tool.result') THEN 'perf-run' END,
      timestamp '2026-10-11 00:00:00' + s * interval '1 second'
    FROM (
      SELECT s, repeat('x', 400) AS body,
        CASE WHEN s > 0 AND s % ${REWIND_EVERY} = 0 THEN 'rewind'
             WHEN ${compact} AND s > 0 AND s % ${COMPACT_EVERY} = 0 THEN 'compaction'
             WHEN s % 4 = 0 THEN 'user.message'
             WHEN s % 4 = 1 THEN 'assistant.text'
             WHEN s % 4 = 2 THEN 'tool.call'
             ELSE 'tool.result' END AS kind
      FROM generate_series(0, ${ENTRIES - 1}) AS s
    ) AS rows`;
  await prisma.conversationSession.update({
    where: { id: sessionId },
    data: { nextEntrySeq: ENTRIES },
  });
  print(`seeded ${tag}: ${ENTRIES} entries in ${(performance.now() - started).toFixed(0)} ms`);
  return sessionId;
}

async function timed(label: string, read: () => Promise<number>): Promise<number> {
  const times: number[] = [];
  let rows = 0;
  for (let run = 0; run < RUNS; run += 1) {
    const started = performance.now();
    rows = await read();
    times.push(performance.now() - started);
  }
  times.sort((left, right) => left - right);
  const median = times[Math.floor(RUNS / 2)]!;
  print(
    `${label}: median ${median.toFixed(1)} ms, range ${times[0]!.toFixed(1)} to ${times.at(-1)!.toFixed(1)} ms over ${RUNS} runs, ${rows} rows`,
  );
  return median;
}

async function chainLength(db: PrismaClient, sessionId: SessionId): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
    WITH RECURSIVE chain AS (
      (SELECT e.id, e."parentId", e.seq, e.type, e."sessionId" FROM session_entries e
       WHERE e."sessionId" = ${sessionId} ORDER BY e.seq DESC LIMIT 1)
      UNION ALL
      SELECT e.id, e."parentId", e.seq, e.type, e."sessionId" FROM session_entries e
      JOIN chain ON e.id = chain."parentId" AND e."sessionId" = chain."sessionId" AND e.seq < chain.seq
      WHERE chain.type <> 'compaction'
    )
    SELECT count(*) FROM chain`;
  return Number(row!.count);
}

await prisma.user.upsert({
  where: { id: "perf-user" },
  create: { id: "perf-user", name: "Perf", email: "perf@rakazo.test" },
  update: {},
});
await prisma.organization.upsert({
  where: { id: "perf-org" },
  create: { id: "perf-org", name: "Perf", slug: "perf-org", createdAt: new Date() },
  update: {},
});
await prisma.space.upsert({
  where: { id: "perf-space" },
  create: { id: "perf-space", organizationId: "perf-org", name: "Perf" },
  update: {},
});
const tag = `perf${Date.now()}`;
const compacted = await seedSession(`${tag}c`, true);
const uncompacted = await seedSession(`${tag}u`, false);
await prisma.$executeRaw`ANALYZE session_entries`;

const tail = await log.readTail(compacted);
print(
  `compacted tail: ${tail.length} entries, first ${tail[0]?.type} at seq ${tail[0]?.seq}, head seq ${tail.at(-1)?.seq}`,
);
const median = await timed("readTail, compaction every 500", async () => {
  const entries = await log.readTail(compacted);
  if (entries[0]?.type !== "compaction") throw new Error("tail did not stop at a compaction");
  return entries.length;
});
const walkOnly = await timed("chain walk alone (SQL count), no compaction", () =>
  chainLength(prisma, uncompacted),
);
const worst = await timed("readTail, no compaction", async () => {
  const entries = await log.readTail(uncompacted);
  if (entries[0]?.seq !== 0) throw new Error("worst case did not reach the first entry");
  return entries.length;
});
const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
  `EXPLAIN (ANALYZE, BUFFERS) WITH RECURSIVE chain AS (
     (SELECT e.* FROM session_entries e WHERE e."sessionId" = $1 ORDER BY e.seq DESC LIMIT 1)
     UNION ALL
     SELECT e.* FROM session_entries e
     JOIN chain ON e.id = chain."parentId" AND e."sessionId" = chain."sessionId" AND e.seq < chain.seq
     WHERE chain.type <> 'compaction'
   ) SELECT * FROM chain ORDER BY seq`,
  compacted,
);
print(plan.map((row) => row["QUERY PLAN"]).join("\n"));
print(
  `${median <= MEDIAN_BUDGET_MS ? "PASS" : "FAIL"}: readTail median ${median.toFixed(1)} ms against the ${MEDIAN_BUDGET_MS} ms budget (pglite reference 3.5 ms)`,
);
print(
  `${walkOnly <= WORST_CASE_BUDGET_MS ? "PASS" : "FAIL"}: chain walk without a compaction ${walkOnly.toFixed(1)} ms against the ${WORST_CASE_BUDGET_MS} ms budget (pglite reference 261 ms)`,
);
print(
  `${worst <= WORST_CASE_BUDGET_MS ? "PASS" : "FAIL"}: readTail returning that whole chain ${worst.toFixed(1)} ms against the ${WORST_CASE_BUDGET_MS} ms budget`,
);
await prisma.$disconnect();
await pool.end();
