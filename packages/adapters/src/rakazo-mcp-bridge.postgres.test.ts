import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NativeSessionHost } from "./native-session-host.js";
import { createNativeSessionHost } from "./native-session-host.js";
import { callAuthorizedTool } from "./rakazo-mcp-bridge.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

const TEST_CATALOG = new Set(["resource.write"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function issueArmed(host: NativeSessionHost, botId: string, threadId: string) {
  const issued = await host.issueTicket(botId, threadId);
  if (!host.armTicket) throw new Error("native host does not support ticket arming");
  await host.armTicket(issued.ticket, `run-${randomUUID()}`);
  return issued;
}

describePostgres("MCP authorized tool call, correlated to a binding generation", () => {
  let pool: Pool;
  let host: NativeSessionHost;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 4 });
    host = createNativeSessionHost(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("stores only a ticket digest and admits calls only while its run is armed", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await host.issueTicket(botId, threadId);

    const row = await pool.query<{ activeAttemptId: string | null }>(
      'select "activeAttemptId" from native_sessions where "botId" = $1 and "threadId" = $2',
      [botId, threadId],
    );
    expect(row.rows[0]?.activeAttemptId).toBe(createHash("sha256").update(ticket).digest("hex"));
    expect(row.rows[0]?.activeAttemptId).not.toBe(ticket);
    await expect(host.reserveCall(ticket, randomUUID(), "resource.write")).resolves.toEqual({
      ok: false,
      reason: "stale_attempt",
    });

    if (!host.armTicket || !host.disarmTicket)
      throw new Error("native host does not support ticket arming");
    await expect(host.armTicket(ticket, "run-1")).resolves.toBe(true);
    await expect(host.reserveCall(ticket, randomUUID(), "resource.write")).resolves.toMatchObject({
      ok: true,
      botId,
      threadId,
    });
    await host.disarmTicket(ticket);
    await expect(host.reserveCall(ticket, randomUUID(), "resource.write")).resolves.toEqual({
      ok: false,
      reason: "stale_attempt",
    });
  });

  it("routes a call with a valid turn authorization through the existing callback and returns its result", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await issueArmed(host, botId, threadId);

    // The test resource: its own public state is the only oracle, never a spy on
    // the callback itself.
    const resource = { writes: 0 };
    const callback = async (_name: string, args: Record<string, unknown>) => {
      resource.writes += 1;
      return { applied: args.value };
    };

    const outcome = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      {
        ticket,
        callId: randomUUID(),
        toolName: "resource.write",
        args: { value: "hello" },
      },
    );

    expect(outcome).toEqual({ ok: true, result: { applied: "hello" } });
    expect(resource.writes).toBe(1);
  });

  it("refuses a stale generation without any effect on the resource", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket: staleTicket } = await issueArmed(host, botId, threadId);
    // Advancing the generation retires the outstanding ticket immediately: the
    // authorization a stale attempt is holding disappears with it (CONTEXT.md
    // "Autorisation de tour").
    await host.advanceGeneration(botId, threadId);

    const resource = { writes: 0 };
    const callback = async (_name: string, args: Record<string, unknown>) => {
      resource.writes += 1;
      return { applied: args.value };
    };

    const outcome = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      {
        ticket: staleTicket,
        callId: randomUUID(),
        toolName: "resource.write",
        args: { value: "hello" },
      },
    );

    expect(outcome).toEqual({ ok: false, error: "stale_attempt" });
    expect(resource.writes).toBe(0);
  });

  it("refuses a ticket that never was, or is no longer, the active one for any binding", async () => {
    // Forged/guessed identity cannot substitute for a session-host-issued
    // ticket: the bridge only ever resolves the ticket, never args.
    const resource = { writes: 0 };
    const callback = async (_name: string, args: Record<string, unknown>) => {
      resource.writes += 1;
      return { applied: args.value };
    };

    const outcome = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      {
        ticket: randomUUID(),
        callId: randomUUID(),
        toolName: "resource.write",
        args: { value: "hello" },
      },
    );

    expect(outcome).toEqual({ ok: false, error: "stale_attempt" });
    expect(resource.writes).toBe(0);
  });

  it("treats the same callId retransmitted under the same binding as a single operation", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await issueArmed(host, botId, threadId);
    const callId = randomUUID();

    const resource = { writes: 0 };
    const callback = async (_name: string, args: Record<string, unknown>) => {
      resource.writes += 1;
      return { applied: args.value };
    };

    const first = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      { ticket, callId, toolName: "resource.write", args: { value: "hello" } },
    );
    const replay = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      { ticket, callId, toolName: "resource.write", args: { value: "hello-again" } },
    );

    expect(first).toEqual({ ok: true, result: { applied: "hello" } });
    expect(replay).toEqual({ ok: false, error: "duplicate_call" });
    expect(resource.writes).toBe(1);
  });

  it("keeps the generation check and the call reservation atomic under a concurrent invalidation", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await issueArmed(host, botId, threadId);

    const resource = { writes: 0 };
    const callback = async (_name: string, args: Record<string, unknown>) => {
      resource.writes += 1;
      return { applied: args.value };
    };

    const [callOutcome] = await Promise.all([
      callAuthorizedTool(
        { host, callTool: callback, catalog: TEST_CATALOG },
        { ticket, callId: randomUUID(), toolName: "resource.write", args: { value: "hello" } },
      ),
      host.advanceGeneration(botId, threadId),
    ]);

    // Whichever side of the race wins, there is no split state: a call that
    // is admitted always wrote once, a refused one never wrote at all.
    if (callOutcome.ok) {
      expect(resource.writes).toBe(1);
    } else {
      expect(callOutcome.error).toBe("stale_attempt");
      expect(resource.writes).toBe(0);
    }
  });

  it("ignores an identity forged in the call arguments: the effect lands only on the ticket's real binding", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    const forgedBotId = `bot-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await issueArmed(host, botId, threadId);

    const writesByBot = new Map<string, number>();
    const callback = async (
      _name: string,
      args: Record<string, unknown>,
      binding: { botId: string },
    ) => {
      writesByBot.set(binding.botId, (writesByBot.get(binding.botId) ?? 0) + 1);
      return { applied: args.value };
    };

    const outcome = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      {
        ticket,
        callId: randomUUID(),
        toolName: "resource.write",
        // A forged identity in the tool's own business arguments: the
        // bridge must never let this substitute for the ticket-resolved
        // binding it passes to the callback.
        args: { value: "hello", botId: forgedBotId },
      },
    );

    expect(outcome).toEqual({ ok: true, result: { applied: "hello" } });
    expect(writesByBot.get(botId)).toBe(1);
    expect(writesByBot.get(forgedBotId)).toBeUndefined();
  });

  it("keeps two real distinct calls distinct: two callIds, two effects", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await issueArmed(host, botId, threadId);

    const resource = { writes: 0 };
    const callback = async (_name: string, args: Record<string, unknown>) => {
      resource.writes += 1;
      return { applied: args.value };
    };

    const first = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      { ticket, callId: randomUUID(), toolName: "resource.write", args: { value: "a" } },
    );
    const second = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      { ticket, callId: randomUUID(), toolName: "resource.write", args: { value: "b" } },
    );

    expect(first).toEqual({ ok: true, result: { applied: "a" } });
    expect(second).toEqual({ ok: true, result: { applied: "b" } });
    expect(resource.writes).toBe(2);
  });

  it("refuses a tool outside the closed catalog without any effect", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await issueArmed(host, botId, threadId);

    const resource = { writes: 0 };
    const callback = async (_name: string, args: Record<string, unknown>) => {
      resource.writes += 1;
      return { applied: args.value };
    };

    const outcome = await callAuthorizedTool(
      { host, callTool: callback, catalog: TEST_CATALOG },
      { ticket, callId: randomUUID(), toolName: "resource.delete", args: { value: "hello" } },
    );

    expect(outcome).toEqual({ ok: false, error: "tool_not_allowed" });
    expect(resource.writes).toBe(0);
  });

  it("blocks a concurrent generation invalidation on the row lock held by an in-flight reservation (TOCTOU, two connections)", async () => {
    const botId = `bot-${randomUUID()}`;
    const threadId = `thread-${randomUUID()}`;
    await host.ensureBinding(botId, threadId);
    const { ticket } = await issueArmed(host, botId, threadId);

    // Two independent connections/hosts: the reservation runs its transaction
    // on `reserveHost`'s pool, the invalidation on a *different* connection
    // (`invalidationPool`), so any blocking observed is a real Postgres row
    // lock, not in-process serialization.
    const invalidationPool = new Pool({ connectionString: databaseUrl!, max: 2 });
    const invalidationHost = createNativeSessionHost(invalidationPool);

    const order: string[] = [];
    let releaseReservation: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });

    let reservePromise: Promise<{ ok: boolean }> | undefined;
    let advancePromise: Promise<unknown> | undefined;

    try {
      reservePromise = host
        .reserveCall(ticket, randomUUID(), "resource.write", {
          afterLock: async () => {
            order.push("reserve:locked");
            await barrier;
          },
        })
        .then((result) => {
          order.push("reserve:done");
          return result;
        });

      // Wait until the reservation's transaction has taken the row lock
      // (bounded poll, no fixed sleep before the condition we assert on).
      const deadline = Date.now() + 5_000;
      while (!order.includes("reserve:locked")) {
        if (Date.now() > deadline) throw new Error("reservation never reached its row lock");
        await sleep(5);
      }

      advancePromise = invalidationHost.advanceGeneration(botId, threadId).then((result) => {
        order.push("advance:done");
        return result;
      });

      // Deterministic oracle: poll `pg_stat_activity` (via a third
      // connection, `pool`) until the concurrent invalidation's own backend
      // is observed actually waiting on the row lock (`wait_event_type =
      // 'Lock'`, running the `update native_sessions` statement) — proof
      // the UPDATE reached Postgres and blocked, not a fixed delay that
      // could elapse before it even arrives under a slow scheduler. Bounded,
      // not a sleep-as-oracle: a removed `FOR UPDATE` never blocks, so the
      // wait either times out (no matching backend) or `advance:done`
      // appears first — both fail the assertions below.
      const lockWaitDeadline = Date.now() + 3_000;
      let observedLockWait = false;
      while (Date.now() < lockWaitDeadline) {
        if (order.includes("advance:done")) break;
        const waiting = await pool.query<{ found: boolean }>(
          `select exists (
             select 1 from pg_stat_activity
             where wait_event_type = 'Lock'
               and query ilike 'update native_sessions%'
               and state = 'active'
           ) as found`,
        );
        if (waiting.rows[0]?.found) {
          observedLockWait = true;
          break;
        }
        await sleep(5);
      }
      expect(observedLockWait).toBe(true);
      expect(order).toEqual(["reserve:locked"]);

      releaseReservation();
      const [reserveResult] = await Promise.all([reservePromise, advancePromise]);

      // Final states only, never an order between the two `.then()`
      // callbacks: after the barrier releases, Postgres commits the
      // reservation and then admits the invalidation, but the JS event loop
      // is free to schedule `reserve:done` and `advance:done` in either
      // order — that ordering is not what the row lock guarantees. What the
      // lock guarantees, and what stays asserted above (line ~298), is that
      // `advance:done` cannot appear *before* the barrier releases.
      expect(order).toContain("reserve:done");
      expect(order).toContain("advance:done");
      expect(reserveResult.ok).toBe(true);
      const finalGeneration = await pool.query<{ generation: number }>(
        `select generation from native_sessions where "botId" = $1 and "threadId" = $2`,
        [botId, threadId],
      );
      expect(finalGeneration.rows[0]?.generation).toBe(1);
      const finalReservation = await pool.query(
        `select 1 from lifecycle_events where "botId" = $1 and "threadId" = $2 and kind = 'mcp_call'`,
        [botId, threadId],
      );
      expect(finalReservation.rowCount).toBe(1);
    } finally {
      // Release the barrier *before* anything else: if an assertion above
      // threw (e.g. the TOCTOU mutant, `advance:done` already present), the
      // reservation's `afterLock` would otherwise stay parked on `barrier`
      // forever, holding its row lock/connection open — the runner cap would
      // then kill the whole run instead of a clean, fast Vitest failure. The
      // wait on both promises is itself bounded so a genuinely stuck
      // transaction cannot hang teardown either.
      releaseReservation();
      await Promise.race([
        Promise.allSettled([reservePromise, advancePromise].filter((p) => p !== undefined)),
        sleep(3_000),
      ]);
      await invalidationPool.end();
    }
  });
});
