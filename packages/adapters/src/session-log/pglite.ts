import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { PrismaClient } from "@rakazo/db";
import { createDb } from "@rakazo/db";

const MIGRATIONS = new URL("../../../db/prisma/migrations/", import.meta.url);
const CONNECTIONS = 4;

/**
 * An in-memory Postgres for tests: PGlite with the repository's migration SQL applied, served over
 * the wire protocol so Prisma talks to it as it talks to Postgres. PGlite runs one transaction at
 * a time, so concurrent transactions here serialize instead of contending for row locks.
 */
export interface PgliteDatabase {
  prisma: PrismaClient;
  close(): Promise<void>;
}

export async function migrationNames(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function applyMigration(pglite: PGlite, name: string): Promise<void> {
  await pglite.exec(await readFile(new URL(`${name}/migration.sql`, MIGRATIONS), "utf8"));
}

export async function openPgliteDatabase(
  migrate: (pglite: PGlite) => Promise<void> = async (pglite) => {
    for (const name of await migrationNames()) await applyMigration(pglite, name);
  },
): Promise<PgliteDatabase> {
  const pglite = await PGlite.create();
  await migrate(pglite);
  const server = new PGLiteSocketServer({ db: pglite, port: 0, maxConnections: CONNECTIONS });
  await server.start();
  const { prisma, pool } = createDb(`postgresql://postgres@${server.getServerConn()}/postgres`, {
    poolMax: CONNECTIONS,
  });
  return {
    prisma,
    async close() {
      await prisma.$disconnect();
      await pool.end();
      await server.stop();
      await pglite.close();
    },
  };
}
