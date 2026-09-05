import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listUserSkills, userSkillsRoot } from "@rakazo/adapters";
import { buildSkillMd } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { exportLegacyAgentSkills } from "./agent-skills-export.js";

describe("exportLegacyAgentSkills", () => {
  it("writes every agent_skills row to disk, deletes it, and is idempotent", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-skills-export-"));
    const rows = [
      {
        id: "row-1",
        spaceId: "ws-1",
        userId: "user-1",
        name: "Alpha",
        content: buildSkillMd({ name: "Alpha", description: "A", body: "" }),
      },
      {
        id: "row-2",
        spaceId: "ws-2",
        userId: "user-9",
        name: "Beta",
        content: buildSkillMd({ name: "Beta", description: "B", body: "" }),
      },
    ];
    const prisma = {
      agentSkill: {
        findMany: vi.fn(async () => rows.map((row) => ({ ...row }))),
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          const index = rows.findIndex((row) => row.id === where.id);
          rows.splice(index, 1);
          return {};
        }),
      },
    } as unknown as PrismaClient;

    expect(await exportLegacyAgentSkills(prisma, dataDir)).toBe(2);
    expect(rows).toEqual([]);
    expect(
      (await listUserSkills(userSkillsRoot(dataDir, { spaceId: "ws-1", userId: "user-1" }))).map(
        (s) => s.name,
      ),
    ).toEqual(["Alpha"]);
    expect(
      (await listUserSkills(userSkillsRoot(dataDir, { spaceId: "ws-2", userId: "user-9" }))).map(
        (s) => s.name,
      ),
    ).toEqual(["Beta"]);
    expect(await exportLegacyAgentSkills(prisma, dataDir)).toBe(0);
    await rm(dataDir, { recursive: true, force: true });
  });
});
