import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("drop_messages_when_logged under a concurrent writer (PostgreSQL)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 3 });
    // The legacy table as the previous release left it; the function reads only its ids.
    await pool.query("CREATE TABLE messages (id text PRIMARY KEY)");
  });
  afterAll(async () => {
    await pool.query("DROP TABLE IF EXISTS messages");
    await pool.end();
  });

  it("waits for a message being written, then keeps the table because the log lacks it", async () => {
    const writer = await pool.connect();
    const dropper = await pool.connect();
    try {
      const { rows: backend } = await dropper.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await writer.query("BEGIN");
      await writer.query("INSERT INTO messages (id) VALUES ('written_during_the_drop')");
      const dropped = dropper.query<{ dropped: boolean }>(
        "SELECT drop_messages_when_logged() AS dropped",
      );
      for (let waiting = 0; waiting === 0; ) {
        const { rows } = await pool.query<{ waiting: number }>(
          "SELECT count(*)::int AS waiting FROM pg_locks WHERE pid = $1 AND NOT granted",
          [backend[0]!.pid],
        );
        waiting = rows[0]!.waiting;
      }
      await writer.query("COMMIT");

      expect((await dropped).rows).toEqual([{ dropped: false }]);
      const { rows } = await pool.query<{ present: boolean }>(
        "SELECT to_regclass('public.messages') IS NOT NULL AS present",
      );
      expect(rows).toEqual([{ present: true }]);
    } finally {
      writer.release();
      dropper.release();
    }
  });
});
