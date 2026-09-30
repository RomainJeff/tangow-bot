import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

/**
 * T02 binding state: one row per bot+thread in `native_sessions` (PA §3.3).
 * The transport (session host) resolves identity and issues an opaque ticket
 * bound to the current attempt/generation via `issueTicket`; the MCP bridge
 * never receives botId/threadId/generation from the caller's own arguments,
 * only the ticket (CONTEXT.md "Autorisation de tour"). `reserveCall` verifies
 * the ticket and reserves the callId atomically against a concurrent
 * invalidation, recording the reservation in `lifecycle_events` (PA §3.4).
 */
export interface NativeSessionHost {
  ensureBinding(botId: string, threadId: string): Promise<{ generation: number }>;
  advanceGeneration(botId: string, threadId: string): Promise<{ generation: number }>;
  issueTicket(botId: string, threadId: string): Promise<{ ticket: string; generation: number }>;
  /** Marks a process-issued ticket usable by exactly one active run. */
  armTicket?(ticket: string, runId: string): Promise<boolean>;
  /** Parks a ticket without revoking it; calls are stale until a later arm. */
  disarmTicket?(ticket: string): Promise<void>;
  /**
   * Retires a ticket at the end of a normal attempt (T01's `close()`),
   * atomically clearing `activeAttemptId` only if it still equals `ticket`.
   * Never advances the generation: the generation carries "attempt N is
   * refused because N+1 replaced it", not routine cleanup of a process that
   * exited on its own. A ticket already superseded by `advanceGeneration`
   * (or by a later `issueTicket`) is left untouched — this never resurrects
   * or clobbers a newer attempt's ticket.
   */
  revokeTicket(botId: string, threadId: string, ticket: string): Promise<void>;
  reserveCall(
    ticket: string,
    callId: string,
    toolName: string,
    hooks?: ReserveCallHooks,
  ): Promise<ReserveResult>;
}

/** Database storage is deliberately one-way: raw bearer tickets stay in process memory only. */
function ticketHash(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

/**
 * Test-only synchronization seam: `afterLock` runs after the row lock
 * (`SELECT ... FOR UPDATE`) is acquired and before the reservation insert,
 * so a Postgres test can prove the lock actually defers a concurrent
 * `advanceGeneration` on a second connection (TOCTOU discrimination). It
 * never substitutes for or bypasses the real transaction/lock.
 */
export interface ReserveCallHooks {
  afterLock?: () => Promise<void> | void;
}

export type ReserveResult =
  | { ok: true; botId: string; threadId: string; generation: number }
  | { ok: false; reason: "stale_attempt" | "duplicate_call" };

export function createNativeSessionHost(pool: Pool): NativeSessionHost {
  return {
    async ensureBinding(botId, threadId) {
      const result = await pool.query<{ generation: number }>(
        `insert into native_sessions (id, "botId", "threadId", "updatedAt")
         values (gen_random_uuid()::text, $1, $2, now())
         on conflict ("botId", "threadId") do update set "botId" = excluded."botId"
         returning generation`,
        [botId, threadId],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Failed to upsert native session binding for ${botId}/${threadId}`);
      return { generation: row.generation };
    },

    async advanceGeneration(botId, threadId) {
      // Advancing the generation retires any outstanding ticket for this binding:
      // a ticket issued for the previous attempt must stop resolving immediately.
      const result = await pool.query<{ generation: number }>(
        `update native_sessions
         set generation = generation + 1, "activeAttemptId" = null, "updatedAt" = now()
         where "botId" = $1 and "threadId" = $2
         returning generation`,
        [botId, threadId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`No native session binding for ${botId}/${threadId}`);
      }
      return { generation: row.generation };
    },

    async issueTicket(botId, threadId) {
      const ticket = randomUUID();
      const result = await pool.query<{ generation: number }>(
        `update native_sessions
         set "activeAttemptId" = $3, "activeRunId" = null, "updatedAt" = now()
         where "botId" = $1 and "threadId" = $2
         returning generation`,
        [botId, threadId, ticketHash(ticket)],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`No native session binding for ${botId}/${threadId}`);
      }
      return { ticket, generation: row.generation };
    },

    async revokeTicket(botId, threadId, ticket) {
      await pool.query(
        `update native_sessions
         set "activeAttemptId" = null, "activeRunId" = null, "updatedAt" = now()
         where "botId" = $1 and "threadId" = $2 and "activeAttemptId" = $3`,
        [botId, threadId, ticketHash(ticket)],
      );
    },

    async armTicket(ticket, runId) {
      const result = await pool.query(
        `update native_sessions
         set "activeRunId" = $2, "updatedAt" = now()
         where "activeAttemptId" = $1
         returning id`,
        [ticketHash(ticket), runId],
      );
      return result.rowCount === 1;
    },

    async disarmTicket(ticket) {
      await pool.query(
        `update native_sessions
         set "activeRunId" = null, "updatedAt" = now()
         where "activeAttemptId" = $1`,
        [ticketHash(ticket)],
      );
    },

    async reserveCall(ticket, callId, toolName, hooks) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Lock the binding row first so a concurrent advanceGeneration (which
        // clears activeAttemptId) cannot interleave between reading the ticket
        // and reserving the callId: both happen inside this one transaction.
        const bindingResult = await client.query<{
          botId: string;
          threadId: string;
          generation: number;
        }>(
          `select "botId", "threadId", generation
           from native_sessions
           where "activeAttemptId" = $1 and "activeRunId" is not null
           for update`,
          [ticketHash(ticket)],
        );
        const binding = bindingResult.rows[0];
        if (!binding) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "stale_attempt" as const };
        }

        await hooks?.afterLock?.();

        const insertResult = await client.query(
          `insert into lifecycle_events (id, "botId", "threadId", kind, "callId", payload, "createdAt")
           values (gen_random_uuid()::text, $1, $2, 'mcp_call', $3, $4, now())
           on conflict ("botId", "threadId", "callId") where "callId" is not null do nothing
           returning id`,
          [binding.botId, binding.threadId, callId, JSON.stringify({ toolName })],
        );
        if (insertResult.rowCount === 0) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "duplicate_call" as const };
        }

        await client.query("COMMIT");
        return {
          ok: true,
          botId: binding.botId,
          threadId: binding.threadId,
          generation: binding.generation,
        };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
