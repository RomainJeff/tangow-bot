/**
 * Database round trips per session log append, counted at the pg client. Seeds one thread, one run
 * and one helper session, then appends the way writers do: a lone append in its own transaction, a
 * run's three entries in one transaction, and a helper's entry. Run against a migrated, disposable
 * database:
 *
 *   DATABASE_URL=postgres://... pnpm exec tsx packages/adapters/src/session-log/append-roundtrips.perf.ts
 */
import type { SessionEntryDraft } from "@rakazo/adapter-kit";
import { EntryId, SessionId } from "@rakazo/contracts";
import { createDb } from "@rakazo/db";
import { PostgresSessionLog } from "./postgres.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL must name a migrated, disposable database");
const { prisma, pool } = createDb(url, { poolMax: 1 });
const statements: string[] = [];
pool.on("connect", (client) => {
  const query = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
    const [first] = args;
    const text = typeof first === "string" ? first : (first as { text?: string })?.text;
    statements.push(
      String(text ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 90),
    );
    return query(...args);
  };
});
const log = new PostgresSessionLog(prisma);
const print = (line: string) => process.stdout.write(`${line}\n`);
const tag = `rt-${Date.now()}`;

async function counted(label: string, appends: number, work: () => Promise<unknown>) {
  statements.length = 0;
  await work();
  const inside = statements.filter((text) => !/^(BEGIN|COMMIT)\b/i.test(text));
  print(
    `${label}: ${statements.length} round trips, ${inside.length} inside the transaction, ${(inside.length / appends).toFixed(1)} per append`,
  );
  for (const text of statements) print(`  ${text}`);
}

await prisma.user.create({ data: { id: tag, name: "RT", email: `${tag}@rakazo.test` } });
await prisma.organization.create({
  data: { id: tag, name: "RT", slug: tag, createdAt: new Date() },
});
await prisma.space.create({ data: { id: tag, organizationId: tag, name: "General" } });
const bot = await prisma.bot.create({
  data: { spaceId: tag, userId: tag, name: "Ada", color: "#00C46A" },
});
const thread = await prisma.thread.create({ data: { spaceId: tag, userId: tag, botId: bot.id } });
const task = await prisma.task.create({
  data: {
    spaceId: tag,
    botId: bot.id,
    threadId: thread.id,
    userId: tag,
    prompt: "",
    status: "running",
  },
});
const run = await prisma.run.create({
  data: {
    spaceId: tag,
    botId: bot.id,
    threadId: thread.id,
    taskId: task.id,
    userId: tag,
    status: "running",
    trigger: "user",
  },
});
const sessionId = SessionId.parse(thread.sessionId);
const said = (text: string): SessionEntryDraft => ({
  sessionId,
  feedBotId: bot.id,
  type: "user.message",
  payload: { blocks: [{ kind: "text", text }], source: "app" },
});
const ran = (type: "assistant.text" | "tool.call", text: string): SessionEntryDraft =>
  type === "tool.call"
    ? {
        sessionId,
        botId: bot.id,
        runId: run.id,
        type,
        payload: { callId: text, name: "web_search", input: "{}" },
      }
    : {
        sessionId,
        botId: bot.id,
        runId: run.id,
        type,
        payload: { blocks: [{ kind: "text", text }] },
      };

await prisma.$transaction((tx) => log.append(tx, said("warm up")));
await counted("lone append, own transaction", 1, () =>
  prisma.$transaction((tx) => log.append(tx, said("hello"))),
);
await counted("three run entries, one transaction", 3, () =>
  prisma.$transaction(async (tx) => {
    await log.append(tx, ran("assistant.text", "one"));
    await log.append(tx, ran("tool.call", "call-1"));
    await log.append(tx, ran("assistant.text", "two"));
  }),
);
const helper = SessionId.parse(`${tag}-helper`);
const [head] = await log.readTail(sessionId).then((entries) => entries.slice(-1));
await prisma.$transaction((tx) =>
  log.createSession(tx, {
    kind: "subagent",
    id: helper,
    spaceId: tag,
    parentSessionId: sessionId,
    parentEntryId: EntryId.parse(head!.id),
  }),
);
await counted("helper entry, own transaction", 1, () =>
  prisma.$transaction((tx) =>
    log.append(tx, { ...ran("assistant.text", "helper"), sessionId: helper }),
  ),
);
await prisma.organization.deleteMany({ where: { id: tag } });
await prisma.user.deleteMany({ where: { id: tag } });
await prisma.$disconnect();
await pool.end();
