import { describe, expect, it, vi } from "vitest";
import type * as AutoReviewModule from "./auto-review.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { executorEffectFixture as fixture } from "./executor-effect.test-support.js";
import type * as MemoryManagementModule from "./memory-management-tools.js";
import { runMemoryManagementTool } from "./memory-management-tools.js";
import { MemoryClassificationConsentRequired } from "./memory-method-classification.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./auto-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AutoReviewModule>()),
  resolveAutoReviewChecker: () => ({ provider: "scripted", model: "checker" }),
  isAutoReviewCheckerConfigured: () => true,
  runAutoReviewJudge: vi.fn(),
}));

vi.mock("./memory-management-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MemoryManagementModule>()),
  runMemoryManagementTool: vi.fn(async () => ({ ok: true })),
}));

describe("memory tools in the run executor", () => {
  it("classifies only through the active bot callback and returns a review suggestion without editing memory", async () => {
    const f = fixture("run-memory-classification");
    f.setCalls([
      {
        name: "classify_memory",
        args: { memoryId: "memory-1", botId: "attacker-bot", methodId: "attacker-method" },
        executionId: "classification-call",
      },
    ]);

    await f.run();

    expect(f.classifyMemoryForBot).toHaveBeenCalledExactlyOnceWith({
      actor: { userId: "user-1", spaceId: "space-1" },
      botId: "bot-1",
      memoryId: "memory-1",
    });
    expect(f.results[0]).toMatchObject({
      classificationId: "classification-1",
      suggestion: { answers: { topic: "interview" } },
      reviewPath: "/app/bot-1",
    });
    expect(f.memoryCommit).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(1);
    expect(f.effects[0]).toMatchObject({ kind: "classify_memory", status: "completed" });
  });

  it("rejects a hostile classification tool call in a group even when the runtime emits it", async () => {
    const f = fixture("run-group-memory-classification", { groupId: "group-1" });
    f.setCalls([
      {
        name: "classify_memory",
        args: { memoryId: "memory-1" },
        executionId: "classification-call",
      },
    ]);

    await f.run();

    expect(f.classifyMemoryForBot).not.toHaveBeenCalled();
    expect(f.results[0]).toEqual({ error: "Memory management is unavailable in this run." });
    expect(f.effects).toHaveLength(0);
  });

  it.each(["prepare_memory_method", "review_memory_classification", "change_memory"])(
    "waits for human approval and replays only the exact approved %s payload",
    async (name) => {
      vi.mocked(runMemoryManagementTool).mockClear();
      const f = fixture(`run-approve-${name}`);
      f.prisma.actionAutoReviewPreference.findUnique.mockResolvedValue({ enabled: true });
      const args = { action: "withdraw", documentId: "memory-1", expectedRevision: 1 };
      f.setCalls([{ name, args, executionId: "original" }]);
      await f.run();
      expect(runMemoryManagementTool).not.toHaveBeenCalled();
      expect(f.pauseRunForInput).toHaveBeenCalledOnce();
      expect(f.effects[0]).toMatchObject({ kind: name, status: "intended", request: args });
      f.effects[0]!.status = "approved";
      f.setCalls([
        { name, args: { ...args, documentId: "unapproved-memory" }, executionId: "resume" },
      ]);
      await f.run();
      expect(runMemoryManagementTool).toHaveBeenCalledExactlyOnceWith(
        f.prisma,
        expect.objectContaining({ userId: "user-1", spaceId: "space-1", isDeploymentOwner: false }),
        "bot-1",
        name,
        args,
        f.effects[0]!.id,
      );
      expect(f.effects[0]!.status).toBe("completed");
      await f.run();
      expect(runMemoryManagementTool).toHaveBeenCalledTimes(1);
    },
  );

  it("does not execute a denied memory change", async () => {
    vi.mocked(runMemoryManagementTool).mockClear();
    const f = fixture("run-denied-memory");
    f.setCalls([
      {
        name: "change_memory",
        args: { action: "withdraw", documentId: "memory-1", expectedRevision: 1 },
        executionId: "denied",
      },
    ]);
    await f.run();
    f.effects[0]!.status = "denied";
    await f.run();
    expect(runMemoryManagementTool).not.toHaveBeenCalled();
    expect(f.effects[0]!.status).toBe("denied");
  });

  it("rejects a revoked capability before any approval or memory operation", async () => {
    vi.mocked(runMemoryManagementTool).mockClear();
    const f = fixture("run-revoked-memory");
    f.prisma.botSkill.findFirst.mockResolvedValue({ enabled: false });
    f.setCalls([
      {
        name: "change_memory",
        args: { action: "withdraw", documentId: "memory-1", expectedRevision: 1 },
        executionId: "revoked",
      },
    ]);
    await f.run();
    expect(f.results[0]).toEqual({ error: "Memory management is unavailable in this run." });
    expect(runMemoryManagementTool).not.toHaveBeenCalled();
    expect(f.pauseRunForInput).not.toHaveBeenCalled();
    expect(f.effects).toHaveLength(0);
  });

  it("does not fall back when classification consent is missing", async () => {
    const f = fixture("run-memory-classification-consent");
    f.classifyMemoryForBot.mockRejectedValueOnce(
      new MemoryClassificationConsentRequired("/app/memory?collection=personal&memory=memory-1"),
    );
    f.setCalls([
      {
        name: "classify_memory",
        args: { memoryId: "memory-1" },
        executionId: "classification-call",
      },
    ]);

    await f.run();

    expect(f.results[0]).toEqual({
      error:
        "Allow the Decision Model in Account settings → AI data sharing, then retry. No suggestion was created.",
      reviewPath: "/app/memory?collection=personal&memory=memory-1",
    });
    expect(f.memoryCommit).not.toHaveBeenCalled();
  });
});
