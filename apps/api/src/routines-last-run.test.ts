import { RPCHandler } from "@orpc/server/fetch";
import type { Actor, Routine } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";
import { lastRunsByRoutine } from "./runs.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

const at = new Date("2026-10-06T10:00:00.000Z");

function routineRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    botId: "bot-1",
    spaceId: "space-1",
    userId: "user-1",
    name: `Routine ${id}`,
    prompt: "check",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: true,
    lastRunAt: at,
    nextRunAt: at,
    createdAt: at,
    ...overrides,
  };
}

const lastRuns = [
  { routineId: "r1", status: "completed", error: null },
  { routineId: "r2", status: "failed", error: "Connect that model provider first" },
  { routineId: "r4", status: "cancelled", error: null },
];

function setup(routines: ReturnType<typeof routineRow>[]) {
  const queryRaw = vi.fn().mockResolvedValue(lastRuns);
  const prisma = {
    routine: {
      findMany: vi.fn().mockResolvedValue(routines),
      findFirst: vi.fn().mockResolvedValue(routines[0]),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...routines[0],
        ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
      })),
    },
    bot: { findFirst: vi.fn().mockResolvedValue({ id: "bot-1", thread: null }) },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    jobs: { enqueue: vi.fn(), cancel: vi.fn() },
    events: { append: vi.fn() },
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  const call = async <T>(proc: string, input: unknown) => {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${proc}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response?.status, body: (await response?.json()) as { json: T } };
  };
  return { queryRaw, call };
}

describe("routine last run", () => {
  it("lists each routine with how its latest finished run ended in one query", async () => {
    const { queryRaw, call } = setup([routineRow("r1"), routineRow("r2"), routineRow("r3")]);
    const { body } = await call<Routine[]>("routines/list", { botId: "bot-1" });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = queryRaw.mock.calls[0]?.[0] as { sql: string; values: unknown[] };
    expect(sql.sql).toContain('DISTINCT ON (r."routineId")');
    expect(sql.sql).toContain('r."spaceId" = ');
    expect(sql.values).toEqual(["space-1", "r1", "r2", "r3", "completed", "failed", "cancelled"]);
    expect(body.json.map((r) => [r.id, r.lastRunStatus, r.lastRunFailureKind] as const)).toEqual([
      ["r1", "succeeded", null],
      ["r2", "failed", "missing_model"],
      ["r3", null, null],
    ]);
    expect(JSON.stringify(body.json)).not.toContain("Connect that model provider first");
  });

  it("keeps the last run when a routine is updated", async () => {
    const { call } = setup([routineRow("r2")]);
    const { body } = await call<Routine>("routines/update", { routineId: "r2", name: "Renamed" });

    expect(body.json).toMatchObject({
      id: "r2",
      name: "Renamed",
      lastRunStatus: "failed",
      lastRunFailureKind: "missing_model",
    });
  });

  it("reads cancelled as cancelled and skips the query for no routines", async () => {
    const queryRaw = vi.fn().mockResolvedValue(lastRuns);
    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
    expect(await lastRunsByRoutine(prisma, "space-1", [])).toEqual(new Map());
    expect(queryRaw).not.toHaveBeenCalled();
    expect((await lastRunsByRoutine(prisma, "space-1", ["r4"])).get("r4")).toEqual({
      lastRunStatus: "cancelled",
      lastRunFailureKind: null,
    });
  });
});
