import { randomUUID } from "node:crypto";
import { createDb } from "@rakazo/db";
import { migrationNames, migrationSql } from "@rakazo/db/pglite.test-support";

/** A disposable database per arm; DATABASE_URL needs permission to create and drop databases. */
export async function openBenchPostgres(url: string) {
  const admin = createDb(url);
  const name = `worker_bench_${randomUUID().replaceAll("-", "")}`;
  const target = new URL(url);
  target.pathname = `/${name}`;
  // The identifier contains only this prefix and random hex, never operator input.
  try {
    await admin.pool.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    await admin.prisma.$disconnect();
    await admin.pool.end();
    throw error;
  }
  const database = createDb(target.toString());
  const close = async () => {
    await database.prisma.$disconnect();
    await database.pool.end();
    try {
      await admin.pool.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.prisma.$disconnect();
      await admin.pool.end();
    }
  };
  try {
    for (const migration of await migrationNames()) {
      const sql = await migrationSql(migration);
      await database.pool.query(sql);
    }
    return { prisma: database.prisma, close };
  } catch (error) {
    await close();
    throw error;
  }
}
