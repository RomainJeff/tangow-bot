import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { manageBotGroup } from "./group-tools.js";

const run = { botId: "coordinator", userId: "owner", spaceId: "space" };
function harness(bots: string[]) {
  const findMany = vi.fn(async () => bots.map((id) => ({ id, name: id, color: "gray" })));
  const prisma = {
    bot: { findMany },
    chatGroup: { findUnique: vi.fn(async () => null) },
  } as unknown as PrismaClient;
  return { prisma, jobs: { cancel: vi.fn() } } as never;
}

describe("mission group tool boundary", () => {
  it("requires an objective and deliverable before creating a group", async () => {
    expect(
      await manageBotGroup(
        harness([]),
        run,
        "create_group",
        { name: "Mission", bot_ids: [] },
        "call",
      ),
    ).toHaveProperty("error");
  });
  it("includes the coordinator when enforcing the six-bot limit", async () => {
    await expect(
      manageBotGroup(
        harness([]),
        run,
        "create_group",
        {
          name: "Mission",
          description: "Objective and deliverable",
          bot_ids: ["1", "2", "3", "4", "5", "6"],
        },
        "call",
      ),
    ).rejects.toThrow("6 distinct bots");
  });
  it("refuses unavailable or foreign members before creating any group", async () => {
    await expect(
      manageBotGroup(
        harness(["coordinator"]),
        run,
        "create_group",
        {
          name: "Mission",
          description: "Objective and deliverable",
          bot_ids: ["foreign"],
        },
        "call",
      ),
    ).rejects.toThrow();
  });
});
