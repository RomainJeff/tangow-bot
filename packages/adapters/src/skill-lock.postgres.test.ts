import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd } from "@tangow/core";
import { createPool } from "@tangow/db";
import { describe, expect, it, vi } from "vitest";
import { listUserSkills, userSkillsRoot, writeUserSkill } from "./skill-store.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

/** A fresh copy of the module, so its in-process queue is not shared: two processes, in effect. */
async function anotherProcess() {
  vi.resetModules();
  return (await import("./skill-lock.js")).createPostgresSkillLock;
}

describePostgres("skill owner lock (PostgreSQL contract)", () => {
  it("serializes one owner's changes across two processes", async () => {
    const apiPool = createPool(databaseUrl!, { poolMax: 2 });
    const workerPool = createPool(databaseUrl!, { poolMax: 2 });
    const apiLock = (await anotherProcess())(apiPool);
    const workerLock = (await anotherProcess())(workerPool);
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

  it("orders two processes editing one skill, losing neither edit", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "tangow-skill-lock-pg-"));
    const owner = { spaceId: "skill-lock-test", userId: `pid-${process.pid}` };
    const root = userSkillsRoot(dataDir, owner);
    const pools = ["api", "worker"].map((name) =>
      createPool(databaseUrl!, { poolMax: 2, applicationName: name }),
    );
    const locks = [(await anotherProcess())(pools[0]!), (await anotherProcess())(pools[1]!)];
    const content = buildSkillMd({ name: "Deploy", description: "About Deploy", body: "Base" });
    try {
      await writeUserSkill(root, { name: "Deploy", content }, "create");
      await Promise.all(
        locks.map((lock, i) =>
          lock.run(owner, async () => {
            const [current] = await listUserSkills(root);
            await new Promise((resolve) => setTimeout(resolve, 200));
            const edited = `${current?.content.trimEnd()}\nedit ${i}\n`;
            await writeUserSkill(root, { name: "Deploy", content: edited }, "replace");
          }),
        ),
      );
      const [deploy] = await listUserSkills(root);
      expect(deploy?.content.trimEnd().split("\n").slice(-2).sort()).toEqual(["edit 0", "edit 1"]);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
