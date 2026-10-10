import type { PrismaClient } from "@rakazo/db";
import { createSkillLibrary } from "./skill-library.js";
import type { SkillOwnerLock } from "./skill-lock.js";
import { createInMemorySkillLock } from "./skill-lock.js";

type Row = Record<string, unknown>;

const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([key, value]) =>
    value && typeof value === "object" && "in" in value
      ? (value.in as unknown[]).includes(row[key])
      : row[key] === value,
  );

function table(rows: Row[]) {
  return {
    rows,
    findMany: async ({ where = {} }: { where?: Row } = {}) =>
      rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    deleteMany: async ({ where }: { where: Row }) => {
      const kept = rows.filter((row) => !matches(row, where));
      const count = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return { count };
    },
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: Record<string, Row>;
      create: Row;
      update: Row;
    }) => {
      const key = Object.values(where)[0] ?? {};
      const index = rows.findIndex((row) => matches(row, key));
      if (index >= 0) {
        rows[index] = { ...rows[index], ...update };
        return rows[index];
      }
      rows.push({ ...create });
      return create;
    },
  };
}

type CrashCounter = {
  steps: number;
  failAt: number;
  step(): void;
  reset(failAt?: number): void;
};

/**
 * A step counter the crash tests arm: the step numbered `failAt` throws instead of running. It
 * lives on globalThis so a mocked node:fs/promises can reach it without importing this module.
 */
export const crash: CrashCounter = {
  steps: 0,
  failAt: Number.POSITIVE_INFINITY,
  step() {
    crash.steps += 1;
    if (crash.steps === crash.failAt) throw new Error(`simulated crash at step ${crash.steps}`);
  },
  reset(failAt = Number.POSITIVE_INFINITY) {
    crash.steps = 0;
    crash.failAt = failAt;
  },
};
(globalThis as { skillCrash?: CrashCounter }).skillCrash = crash;

/** The access tables, bots and users the skill library reads; every transaction is one crash step. */
export function fakeSkillPrisma(options: { bots?: string[]; users?: string[] } = {}) {
  const bots = options.bots ?? ["bot-1", "bot-2"];
  const users = options.users ?? ["user-1"];
  const skillSetting = table([]);
  const botSkill = table([]);
  return {
    skillSetting,
    botSkill,
    bot: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        bots.filter((id) => where.id.in.includes(id)).map((id) => ({ id })),
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.includes(where.id) ? { id: where.id } : null,
    },
    $transaction: async (ops: Promise<unknown>[]) => {
      crash.step();
      return Promise.all(ops);
    },
  };
}

export type FakeSkillPrisma = ReturnType<typeof fakeSkillPrisma>;

export function testLibrary(
  dataDir: string,
  options: {
    prisma?: FakeSkillPrisma;
    lock?: SkillOwnerLock;
    now?: () => Date;
    quotaBytes?: number;
  } = {},
) {
  const prisma = options.prisma ?? fakeSkillPrisma();
  const library = createSkillLibrary({
    prisma: prisma as unknown as PrismaClient,
    dataDir,
    lock: options.lock ?? createInMemorySkillLock(),
    now: options.now,
    quotaBytes: options.quotaBytes,
  });
  return { prisma, library };
}
