import { getLogger } from "@rakazo/logging";
import type { Pool } from "pg";
import { unavailable } from "./skill-tree.js";

export type SkillOwner = { spaceId: string; userId: string };

/** Serializes every change to one owner's skills, whichever process (API or worker) makes it. */
export interface SkillOwnerLock {
  run<T>(owner: SkillOwner, fn: () => Promise<T>): Promise<T>;
}

const ownerKey = (owner: SkillOwner) => `${owner.spaceId}/${owner.userId}`;

/** One queue per owner, inside one process. */
export function createInMemorySkillLock(): SkillOwnerLock {
  const tails = new Map<string, Promise<void>>();
  return {
    async run(owner, fn) {
      const key = ownerKey(owner);
      const prior = tails.get(key) ?? Promise.resolve();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prior.then(() => held);
      tails.set(key, tail);
      await prior;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

// Shared by every Postgres lock of the process: callers queue here first, so the process holds
// at most one lock connection per owner while it waits on Postgres.
const processQueue = createInMemorySkillLock();

// Far above an operation's few hundred milliseconds, and under the pool's 10 s checkout wait: a
// caller stuck behind another process gives its connection back before the next checkout gives up.
const LOCK_WAIT = "SET lock_timeout = 5000";
const LOCK = "SELECT pg_advisory_lock(hashtext('skill-library'), hashtext($1))";
const UNLOCK = "SELECT pg_advisory_unlock(hashtext('skill-library'), hashtext($1)) AS released";

/**
 * The production lock: a session advisory lock per (space, user), held on a connection of its own
 * pool. The change itself queries through the app's pool, so holding the lock never takes a
 * connection the change needs. A crash closes the connection and frees the lock. A lock not
 * taken in time is refused as unavailable, and the change does not run.
 */
export function createPostgresSkillLock(pool: Pick<Pool, "connect">): SkillOwnerLock {
  const refuse = (error: unknown) => {
    getLogger().warn("[skills] could not take the owner lock", { error });
    return unavailable();
  };
  return {
    run: (owner, fn) =>
      processQueue.run(owner, async () => {
        const key = ownerKey(owner);
        const client = await pool.connect().catch((error: unknown) => {
          throw refuse(error);
        });
        try {
          await client.query(LOCK_WAIT);
          await client.query(LOCK, [key]);
        } catch (error) {
          client.release(true);
          throw refuse(error);
        }
        try {
          return await fn();
        } finally {
          const released = await client.query<{ released: boolean }>(UNLOCK, [key]).then(
            (result) => result.rows[0]?.released === true,
            (error: unknown) => {
              getLogger().warn("[skills] could not release the owner lock", { error });
              return false;
            },
          );
          // A connection whose lock state is uncertain never goes back to the pool.
          client.release(!released);
        }
      }),
  };
}
