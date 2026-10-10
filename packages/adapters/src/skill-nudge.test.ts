import { describe, expect, it } from "vitest";
import type { SkillNudgeDeps } from "./skill-nudge.js";
import { decideSkillNudge, SKILL_NUDGE_TOOL_DEFS } from "./skill-nudge.js";

describe("the skill nudge's tools", () => {
  it("offer no draft folder, in their schema or in their description", () => {
    expect(SKILL_NUDGE_TOOL_DEFS.map((tool) => tool.name).sort()).toEqual([
      "skill_create",
      "skill_read",
      "skill_search",
      "skill_update",
    ]);
    for (const tool of SKILL_NUDGE_TOOL_DEFS) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(properties).not.toHaveProperty("path");
      expect(tool.description).not.toMatch(/\bpass path\b|workspace folder/i);
    }
  });
});

describe("whether an exchange earns the nudge", () => {
  const longExchange = Array.from({ length: 15 }, () => ({
    type: "agent.tool.completed",
    payload: { name: "skill_search", outcome: "succeeded" },
  }));
  const deps = {
    prisma: {
      event: { findMany: async () => longExchange },
      run: { findMany: async () => [] },
      externalEffect: { findMany: async () => [] },
    },
    events: { append: async () => undefined },
  } as unknown as SkillNudgeDeps;
  const exchange = (steeredByOthers: boolean) => ({
    run: {
      id: "run-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      threadId: "thread-1",
      trigger: "user",
      createdAt: new Date(0),
    },
    replied: true,
    budgetExhausted: false,
    steeredByOthers,
  });

  it("passes over a long exchange someone else steered into, as one the user did not start", async () => {
    expect(await decideSkillNudge(deps, "on", exchange(false))).toEqual({
      nudge: true,
      mode: "on",
      signal: { signal: "tools", toolCount: 15 },
    });
    expect(await decideSkillNudge(deps, "on", exchange(true))).toEqual({
      nudge: false,
      reason: "not_user_started",
    });
  });
});
