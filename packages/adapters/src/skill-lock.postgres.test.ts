import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd } from "@rakazo/core";
import { createDb, createPool } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/** Fresh copies of the modules, so their in-process queue is not shared: two processes, in effect. */
async function anotherProcess() {
  vi.resetModules();
  const [{ createPostgresSkillLock }, { createSkillLibrary }] = await Promise.all([
    import("./skill-lock.js"),
    import("./skill-library.js"),
  ]);
  return { createPostgresSkillLock, createSkillLibrary };
}

describePostgres("skill owner lock (PostgreSQL contract)", () => {
  it("serializes one owner's changes across two processes", async () => {
    const apiPool = createPool(databaseUrl!, { poolMax: 2 });
    const workerPool = createPool(databaseUrl!, { poolMax: 2 });
    const apiLock = (await anotherProcess()).createPostgresSkillLock(apiPool);
    const workerLock = (await anotherProcess()).createPostgresSkillLock(workerPool);
    const owner = { spaceId: "skill-lock-test", userId: `pid-${process.pid}` };
    const log: string[] = [];
    const change = (name: string) => async () => {
      log.push(`${name} start`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      log.push(`${name} end`);
    };
    try {
      await Promise.all([
        apiLock.run(owner, change("api")),
        workerLock.run(owner, change("worker")),
      ]);
      const [first, second] = log[0]?.startsWith("api") ? ["api", "worker"] : ["worker", "api"];
      expect(log).toEqual([`${first} start`, `${first} end`, `${second} start`, `${second} end`]);
    } finally {
      await apiPool.end();
      await workerPool.end();
    }
  });

  it("orders two processes writing one skill into two versions, losing neither", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-skill-lock-pg-"));
    const processes = await Promise.all(
      ["api", "worker"].map(async (name) => {
        const db = createDb(databaseUrl!, { poolMax: 4, applicationName: name });
        const lockPool = createPool(databaseUrl!, { poolMax: 2 });
        const modules = await anotherProcess();
        const library = modules.createSkillLibrary({
          prisma: db.prisma,
          dataDir,
          lock: modules.createPostgresSkillLock(lockPool),
        });
        const close = async () => {
          await db.prisma.$disconnect();
          await db.pool.end();
          await lockPool.end();
        };
        return { name, library, close };
      }),
    );
    const owner = { spaceId: "skill-library-test", userId: `pid-${process.pid}` };
    const content = (body: string) => ({
      kind: "skill-md" as const,
      name: "Deploy",
      content: buildSkillMd({ name: "Deploy", description: "About Deploy", body }),
    });
    try {
      const [api, worker] = processes;
      await api?.library.forOwner(owner).create(content("Base"));
      await Promise.all(
        processes.map((p) => p.library.forOwner(owner).update("user:deploy", content(p.name))),
      );
      const versions = await worker?.library.forOwner(owner).versions("user:deploy");
      expect(versions?.map((v) => v.seq)).toEqual([3, 2, 1]);
      expect(new Set(versions?.map((v) => v.fingerprint)).size).toBe(3);
    } finally {
      await Promise.all(processes.map((p) => p.close()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
