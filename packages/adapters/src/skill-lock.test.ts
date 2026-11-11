import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool, PrismaClient } from "@tangow/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemorySkillLock, createPostgresSkillLock } from "./skill-lock.js";
import { skillCreateFromTool } from "./skill-tools.js";

const alice = { spaceId: "ws-1", userId: "alice" };
const bob = { spaceId: "ws-1", userId: "bob" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Postgres session advisory locks, as far as the skill lock uses them. */
function advisoryServer() {
  const held = new Map<string, number>();
  const waiting = new Map<string, Array<() => void>>();
  let sessions = 0;
  const free = (key: string) => {
    held.delete(key);
    waiting.get(key)?.shift()?.();
  };
  const pool = (options: { unlockFails?: boolean } = {}) => {
    const returned: Array<"kept" | "destroyed"> = [];
    const connections = {
      connect: async () => {
        const session = ++sessions;
        let lockTimeoutMs = 0;
        return {
          async query(sql: string, [key = ""]: string[] = []) {
            const timeout = /^SET lock_timeout = (\d+)$/.exec(sql);
            if (timeout) {
              lockTimeoutMs = Number(timeout[1]);
              return { rows: [] };
            }
            if (sql.includes("pg_advisory_lock(")) {
              while (held.has(key)) {
                await new Promise<void>((resolve, reject) => {
                  const wake = () => {
                    clearTimeout(timer);
                    resolve();
                  };
                  const timer =
                    lockTimeoutMs > 0
                      ? setTimeout(() => {
                          waiting.set(
                            key,
                            (waiting.get(key) ?? []).filter((waiter) => waiter !== wake),
                          );
                          reject(
                            Object.assign(new Error("canceling statement due to lock timeout"), {
                              code: "55P03",
                            }),
                          );
                        }, lockTimeoutMs)
                      : undefined;
                  waiting.set(key, [...(waiting.get(key) ?? []), wake]);
                });
              }
              held.set(key, session);
              return { rows: [] };
            }
            if (options.unlockFails) throw new Error("connection lost");
            const mine = held.get(key) === session;
            if (mine) free(key);
            return { rows: [{ released: mine }] };
          },
          release(destroy?: boolean) {
            returned.push(destroy ? "destroyed" : "kept");
            if (!destroy) return;
            for (const [key, owner] of held) if (owner === session) free(key);
          },
        };
      },
    };
    return Object.assign(connections as unknown as Pool, { returned });
  };
  return { pool };
}

/** A fresh copy of the module, so its in-process queue is not shared: two processes, in effect. */
async function lockOfAnotherProcess() {
  vi.resetModules();
  return (await import("./skill-lock.js")).createPostgresSkillLock;
}

type Row = Record<string, unknown>;

/** The access rows a bot's skill create reads and writes. */
function accessRows() {
  const rows: Row[] = [];
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  return {
    findMany: async ({ where }: { where: Row }) => rows.filter((row) => matches(row, where)),
    deleteMany: async ({ where }: { where: Row }) => {
      const kept = rows.filter((row) => !matches(row, where));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count };
    },
    upsert: async ({ create }: { create: Row }) => {
      rows.push(create);
      return create;
    },
  };
}

/**
 * The app's Prisma pool: each query, or batch of queries in one transaction, holds one of `size`
 * connections, and a caller waits at most `waitMs` for one.
 */
function pooledPrisma(size: number, waitMs: number) {
  let free = size;
  const queue: Array<() => void> = [];
  const withConnection = async <T>(work: () => Promise<T>): Promise<T> => {
    if (free > 0) free -= 1;
    else {
      await new Promise<void>((resolve, reject) => {
        const take = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          queue.splice(queue.indexOf(take), 1);
          reject(new Error("Timed out waiting for a pooled connection."));
        }, waitMs);
        queue.push(take);
      });
    }
    try {
      return await work();
    } finally {
      const next = queue.shift();
      if (next) next();
      else free += 1;
    }
  };
  const base = { skillSetting: accessRows(), botSkill: accessRows() };
  const lazy = <T extends Record<string, unknown>>(table: T) =>
    Object.fromEntries(
      Object.entries(table).map(([name, value]) => [
        name,
        typeof value === "function"
          ? (...args: unknown[]) => {
              const query = () => (value as (...a: unknown[]) => Promise<unknown>)(...args);
              return {
                query,
                // biome-ignore lint/suspicious/noThenProperty: like a Prisma query, it runs only once awaited.
                then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
                  withConnection(query).then(ok, ko),
              };
            }
          : value,
      ]),
    );
  return {
    ...base,
    skillSetting: lazy(base.skillSetting),
    botSkill: lazy(base.botSkill),
    bot: lazy({ findFirst: async () => null }),
    $transaction: (batch: Array<{ query: () => Promise<unknown> }>) =>
      withConnection(() => Promise.all(batch.map((op) => op.query()))),
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("skill owner lock", () => {
  it("runs one owner's changes one at a time and other owners alongside", async () => {
    const lock = createInMemorySkillLock();
    const log: string[] = [];
    const work = (name: string) => async () => {
      log.push(`${name} start`);
      await tick();
      log.push(`${name} end`);
    };
    await Promise.all([
      lock.run(alice, work("alice 1")),
      lock.run(alice, work("alice 2")),
      lock.run(bob, work("bob")),
    ]);
    const at = (entry: string) => log.indexOf(entry);
    expect(at("alice 2 start")).toBeGreaterThan(at("alice 1 end"));
    expect(at("bob start")).toBeLessThan(at("alice 1 end"));
    expect(log).toHaveLength(6);
  });

  it("keeps going after a change that failed", async () => {
    const lock = createInMemorySkillLock();
    await expect(lock.run(alice, async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(await lock.run(alice, async () => "next")).toBe("next");
  });

  it("serializes one owner's changes across two processes through Postgres", async () => {
    const server = advisoryServer();
    const api = (await lockOfAnotherProcess())(server.pool());
    const worker = (await lockOfAnotherProcess())(server.pool());
    const log: string[] = [];
    const change = (name: string) => async () => {
      log.push(`${name} start`);
      await tick();
      log.push(`${name} end`);
    };
    await Promise.all([api.run(alice, change("api")), worker.run(alice, change("worker"))]);
    const [first, second] = log[0]?.startsWith("api") ? ["api", "worker"] : ["worker", "api"];
    expect(log).toEqual([`${first} start`, `${first} end`, `${second} start`, `${second} end`]);
  });

  it("frees the lock after a failed change and drops a connection it could not unlock", async () => {
    const server = advisoryServer();
    const broken = server.pool({ unlockFails: true });
    const healthy = server.pool();
    await expect(
      createPostgresSkillLock(broken).run(alice, async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await (await lockOfAnotherProcess())(healthy).run(alice, async () => "next")).toBe(
      "next",
    );
    expect([broken.returned, healthy.returned]).toEqual([["destroyed"], ["kept"]]);
  });

  it("refuses without running the change when it cannot get the lock in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const server = advisoryServer();
      let release = () => {};
      let started = () => {};
      const holding = new Promise<void>((resolve) => {
        started = resolve;
      });
      const held = (await lockOfAnotherProcess())(server.pool()).run(alice, () => {
        started();
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      });
      await holding;
      const waiter = server.pool();
      const ran: string[] = [];
      const refusal = (error: Error) => error.message;
      const waited = (await lockOfAnotherProcess())(waiter)
        .run(alice, async () => {
          ran.push("ran");
        })
        .catch(refusal);
      await vi.advanceTimersByTimeAsync(5_000);
      const unreachable = {
        connect: () => Promise.reject(new Error("timeout exceeded when trying to connect")),
      } as unknown as Pool;

      expect([await waited, ran, waiter.returned]).toEqual([
        "Could not take the skill owner lock.",
        [],
        ["destroyed"],
      ]);
      expect(
        await createPostgresSkillLock(unreachable)
          .run(bob, async () => "ran")
          .catch(refusal),
      ).toEqual("Could not take the skill owner lock.");
      release();
      await held;
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets more owners write at once than the app's pool has connections", {
    timeout: 120_000,
  }, async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-skill-lock-"));
    dirs.push(dataDir);
    const deps = {
      prisma: pooledPrisma(4, 10_000) as unknown as PrismaClient,
      dataDir,
      learning: "off" as const,
      lock: createPostgresSkillLock(advisoryServer().pool()),
    };
    const owners = Array.from({ length: 6 }, (_, i) => ({
      spaceId: "ws-1",
      userId: `user-${i}`,
      botId: `bot-${i}`,
    }));
    const results = await Promise.all(
      owners.map((owner) =>
        skillCreateFromTool(deps, owner, [], {
          name: "Deploy",
          description: "About Deploy",
          body: "Steps",
        }).then((result) => result.id ?? result.error),
      ),
    );
    expect(results).toEqual(owners.map(() => "user:deploy"));
  });
});
