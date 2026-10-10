import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSkillMd, skillHistorySegments } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerSkillAdmin, SkillUid, VersionId } from "./skill-library.js";
import { crash, fakeSkillPrisma, testLibrary } from "./skill-library.test-support.js";
import { listUserSkills, userSkillsRoot } from "./skill-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const crashStep = () => (globalThis as { skillCrash?: { step(): void } }).skillCrash?.step();
  const step =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      crashStep();
      return fn(...args);
    };
  // A crash inside a recursive rm leaves it half done: its first entry is gone, the rest stays.
  const rm: typeof fs.rm = async (target, options) => {
    try {
      crashStep();
    } catch (error) {
      const [first] = options?.recursive ? (await fs.readdir(target).catch(() => [])).sort() : [];
      if (first) await fs.rm(`${target}/${first}`, { recursive: true, force: true });
      throw error;
    }
    return fs.rm(target, options);
  };
  return {
    ...fs,
    mkdir: step(fs.mkdir),
    open: step(fs.open),
    writeFile: step(fs.writeFile),
    rename: step(fs.rename),
    rm,
  };
});

const owner = { spaceId: "ws-1", userId: "user-1" };
const md = (name: string, body = "Steps") =>
  buildSkillMd({ name, description: `About ${name}`, body });
const ada = { botId: "bot-1", botName: "Ada", runId: "run-1", toolCallId: "call-1", secrets: [] };

const dirs: string[] = [];
afterEach(async () => {
  crash.reset();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Scenario = {
  name: string;
  /** Builds the state before the operation; never crashes. */
  seed: (
    admin: OwnerSkillAdmin,
    writeAsBot: () => Promise<unknown>,
  ) => Promise<SkillUid | undefined>;
  act: (
    admin: OwnerSkillAdmin,
    uid: SkillUid | undefined,
    writeAsBot: () => Promise<unknown>,
  ) => Promise<unknown>;
};

const reservedBotSkill = async (_: OwnerSkillAdmin, writeAsBot: () => Promise<unknown>) => {
  await writeAsBot();
  return undefined;
};

const scenarios: Scenario[] = [
  {
    name: "a bot creating a skill",
    seed: async () => undefined,
    act: (_admin, _uid, writeAsBot) => writeAsBot(),
  },
  {
    name: "renaming a reserved skill",
    seed: reservedBotSkill,
    act: (admin) =>
      admin.update("user:deploy", { kind: "skill-md", name: "Ship", content: md("Ship") }),
  },
  {
    name: "deleting a reserved skill",
    seed: reservedBotSkill,
    act: (admin) => admin.delete("user:deploy"),
  },
  {
    name: "restoring a reserved skill from the trash",
    seed: async (admin, writeAsBot) => {
      await writeAsBot();
      return (await admin.delete("user:deploy")).uid;
    },
    act: (admin, uid) => admin.restore(uid as SkillUid),
  },
  {
    name: "undoing a rename of a reserved skill",
    seed: async (admin, writeAsBot) => {
      await writeAsBot();
      return (
        await admin.update("user:deploy", { kind: "skill-md", name: "Ship", content: md("Ship") })
      ).uid;
    },
    act: async (admin, uid) => {
      const [current] = await admin.versions("user:ship");
      return admin.undo(uid as SkillUid, current?.versionId ?? ("" as never));
    },
  },
];

async function run(scenario: Scenario, failAt: number) {
  const data = await mkdtemp(path.join(tmpdir(), "rakazo-skill-crash-"));
  dirs.push(data);
  const prisma = fakeSkillPrisma();
  const { library } = testLibrary(data, { prisma });
  const admin = library.forOwner(owner);
  const writeAsBot = () =>
    library.forBot(owner, ada).create({ kind: "skill-md", name: "Deploy", content: md("Deploy") });
  const uid = await scenario.seed(admin, writeAsBot);
  crash.reset(failAt);
  const outcome = await scenario.act(admin, uid, writeAsBot).then(
    () => "done",
    (error: Error) => error.message,
  );
  const steps = crash.steps;
  crash.reset();
  await library.repair(owner);
  return { data, prisma, admin, outcome, steps };
}

describe("a crash at any step of a skill operation", () => {
  for (const scenario of scenarios) {
    it(`never widens access or loses the skill: ${scenario.name}`, {
      timeout: 180_000,
    }, async () => {
      const { steps } = await run(scenario, Number.POSITIVE_INFINITY);
      expect(steps).toBeGreaterThan(3);
      for (let failAt = 1; failAt <= steps; failAt += 1) {
        const { data, prisma, admin, outcome } = await run(scenario, failAt);
        const at = `${scenario.name}, crash at step ${failAt} (${outcome})`;
        const live = await listUserSkills(userSkillsRoot(data, owner));
        const trash = await admin.trash();

        // The skill exists once, live or in the trash; a creation may also not have happened.
        expect(live.length + trash.length, at).toBe(
          scenario.name === "a bot creating a skill" && live.length === 0 ? 0 : 1,
        );
        for (const skill of live) {
          // Still reserved to its bot: no other bot sees it, so nothing widened to "all".
          expect(
            prisma.skillSetting.rows
              .filter((row) => row.skillKey === skill.id)
              .map((row) => row.availability),
            at,
          ).toEqual(["selected"]);
          expect(
            prisma.botSkill.rows.filter((row) => row.skillKey === skill.id).map((row) => row.botId),
            at,
          ).toEqual(["bot-1"]);
          // The store's own partial write is never mistaken for an outside change.
          const [current] = await admin.versions(skill.id);
          expect(current?.author.kind, at).not.toBe("unknown");
        }
        expect(prisma.skillSetting.rows.length, at).toBe(live.length);
        expect(prisma.botSkill.rows.length, at).toBe(live.length);
        // No half-claimed folder, journal or staging is left behind.
        const entries = (dir: string) => readdir(dir).catch(() => [] as string[]);
        expect((await entries(userSkillsRoot(data, owner))).length, at).toBe(live.length);
        expect(
          (await entries(path.join(data, ...skillHistorySegments(owner)))).filter(
            (name) => name !== "skills",
          ),
          at,
        ).toEqual([]);
      }
    });
  }
});

describe("replacing a skill's folder under the same name", () => {
  const folder = (body: string) => ({
    kind: "files" as const,
    name: "Deploy",
    content: md("Deploy", body),
    files: [
      { path: "SKILL.md", bytes: new TextEncoder().encode(md("Deploy", body)), executable: false },
      { path: `scripts/${body}.sh`, bytes: new TextEncoder().encode(body), executable: true },
    ],
  });

  async function replaceAndCrash(failAt: number) {
    const data = await mkdtemp(path.join(tmpdir(), "rakazo-skill-crash-"));
    dirs.push(data);
    const admin = testLibrary(data).library.forOwner(owner);
    await admin.create(folder("one"));
    crash.reset(failAt);
    await admin.update("user:deploy", folder("two")).catch(() => undefined);
    const steps = crash.steps;
    crash.reset();
    return { names: (await listUserSkills(userSkillsRoot(data, owner))).map((s) => s.name), steps };
  }

  it("never leaves a moment where the skill is missing", { timeout: 180_000 }, async () => {
    const { steps } = await replaceAndCrash(Number.POSITIVE_INFINITY);
    for (let failAt = 1; failAt <= steps; failAt += 1) {
      expect((await replaceAndCrash(failAt)).names, `crash at step ${failAt}`).toEqual(["Deploy"]);
    }
  });
});

describe("a crash at any step of erasing history", () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));

  /** Crashes `act` at step 1, 2, ... until it completes, checking what the owner sees after each. */
  async function eachCrash(
    seed: (admin: OwnerSkillAdmin, prisma: ReturnType<typeof fakeSkillPrisma>) => Promise<SkillUid>,
    act: (admin: OwnerSkillAdmin, uid: SkillUid, clock: { now: Date }) => Promise<unknown>,
    check: (
      admin: OwnerSkillAdmin,
      uid: SkillUid,
      at: string,
      prisma: ReturnType<typeof fakeSkillPrisma>,
    ) => Promise<void>,
  ) {
    for (let failAt = 1; failAt < 500; failAt += 1) {
      const data = await mkdtemp(path.join(tmpdir(), "rakazo-skill-crash-"));
      dirs.push(data);
      const clock = { now: day(1) };
      const prisma = fakeSkillPrisma();
      const { library } = testLibrary(data, { prisma, now: () => clock.now });
      const admin = library.forOwner(owner);
      const uid = await seed(admin, prisma);
      crash.reset(failAt);
      const outcome = await act(admin, uid, clock).then(
        () => "done",
        (error: Error) => error.message,
      );
      crash.reset();
      await library.repair(owner);
      const at = `crash at step ${failAt} (${outcome})`;
      await check(admin, uid, at, prisma);
      expect(
        (await readdir(path.join(data, ...skillHistorySegments(owner)))).filter(
          (name) => name !== "skills",
        ),
        at,
      ).toEqual([]);
      if (outcome === "done") return;
    }
    throw new Error("the operation never completed");
  }

  const reservedInTrash = async (
    admin: OwnerSkillAdmin,
    prisma: ReturnType<typeof fakeSkillPrisma>,
  ) => {
    const { uid } = await admin.create({ kind: "skill-md", name: "Deploy", content: md("Deploy") });
    prisma.skillSetting.rows.push({ ...owner, skillKey: "user:deploy", availability: "selected" });
    prisma.botSkill.rows.push({ ...owner, skillKey: "user:deploy", botId: "bot-1", enabled: true });
    await admin.delete("user:deploy");
    return uid;
  };

  it("purges for good or not at all, never back in the trash with wider access", {
    timeout: 180_000,
  }, async () => {
    await eachCrash(
      reservedInTrash,
      (admin, uid, clock) => {
        clock.now = day(2);
        return admin.purge(uid);
      },
      async (admin, uid, at, prisma) => {
        const trash = await admin.trash();
        if (trash.length === 0) return;
        expect(trash, at).toEqual([{ uid, name: "Deploy", trashedAt: day(1).toISOString() }]);
        await admin.restore(uid);
        expect(
          prisma.skillSetting.rows.map((row) => row.availability),
          at,
        ).toEqual(["selected"]);
        expect(
          prisma.botSkill.rows.map((row) => row.botId),
          at,
        ).toEqual(["bot-1"]);
      },
    );
  });

  it("expires the trash for good after thirty days", { timeout: 180_000 }, async () => {
    await eachCrash(
      reservedInTrash,
      (admin, _uid, clock) => {
        clock.now = day(32);
        return admin.trash();
      },
      async (admin, _uid, at) => {
        expect(await admin.trash(), at).toEqual([]);
      },
    );
  });

  it("deletes a version for good or not at all, never leaving it damaged", {
    timeout: 180_000,
  }, async () => {
    let middle = "" as VersionId;
    await eachCrash(
      async (admin) => {
        const write = (body: string) =>
          admin.update("user:deploy", {
            kind: "skill-md",
            name: "Deploy",
            content: md("Deploy", body),
          });
        const { uid } = await admin.create({
          kind: "skill-md",
          name: "Deploy",
          content: md("Deploy"),
        });
        middle = (await write("Two")).versionId;
        await write("Three");
        return uid;
      },
      (admin, uid) => admin.deleteVersion(uid, middle),
      async (admin, uid, at) => {
        const [current, ...older] = await admin.versions("user:deploy");
        expect(
          older.map((v) => v.seq),
          at,
        ).toEqual(older.some((v) => v.versionId === middle) ? [2, 1] : [1]);
        expect((await admin.undo(uid, current?.versionId as VersionId)).kind, at).toBe("restored");
      },
    );
  });
});

describe("changing access after a rename crashed", () => {
  async function renameCrashThenOpen(failAt: number) {
    const data = await mkdtemp(path.join(tmpdir(), "rakazo-skill-crash-"));
    dirs.push(data);
    const prisma = fakeSkillPrisma();
    const { library } = testLibrary(data, { prisma });
    const admin = library.forOwner(owner);
    await library
      .forBot(owner, ada)
      .create({ kind: "skill-md", name: "Deploy", content: md("Deploy") });
    crash.reset(failAt);
    await admin
      .update("user:deploy", { kind: "skill-md", name: "Ship", content: md("Ship") })
      .catch(() => undefined);
    const steps = crash.steps;
    crash.reset();
    const opened = await admin.setAccess("user:deploy", { availability: "all", bots: [] }).then(
      () => "applied",
      (error: Error & { reason?: string }) => error.reason ?? error.message,
    );
    await library.repair(owner);
    const [live] = await listUserSkills(userSkillsRoot(data, owner));
    const availability = prisma.skillSetting.rows
      .filter((row) => row.skillKey === live?.id)
      .map((row) => row.availability);
    return { steps, seen: [opened, live?.id, availability] };
  }

  it("lands on the skill or is refused, never lost", { timeout: 180_000 }, async () => {
    const { steps } = await renameCrashThenOpen(Number.POSITIVE_INFINITY);
    for (let failAt = 1; failAt <= steps; failAt += 1) {
      expect([
        ["applied", "user:deploy", ["all"]],
        ["not_found", "user:ship", ["selected"]],
      ]).toContainEqual((await renameCrashThenOpen(failAt)).seen);
    }
  });
});
