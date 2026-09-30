import { describe, expect, it, vi } from "vitest";
import { createNativeSessionStore } from "./native-session-store.js";

describe("NativeSessionStore", () => {
  it("records the harness and state when the host already created generation zero", async () => {
    const upsert = vi.fn(async ({ update }: { update: Record<string, unknown> }) => ({
      ...update,
    }));
    const create = vi.fn(async () => undefined);
    const prisma = {
      nativeSession: { upsert },
      lifecycleEvent: { create },
    };
    const store = createNativeSessionStore(prisma as never);

    await store.record({
      botId: "bot-1",
      threadId: "thread-1",
      ref: { bindingId: "thread-1", generation: 0 },
      nativeRef: "native-1",
      processRef: "process-1",
      harness: "codex-native",
      executionTarget: "computer-1",
      continuity: "new",
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          nativeRef: "native-1",
          processRef: "process-1",
          harness: "codex-native",
          executionTarget: "computer-1",
          state: "attached",
          processState: "running",
        },
      }),
    );
  });

  describe("continuity across harnesses and Computers", () => {
    type Harness = "codex-native" | "claude-native";
    const row = (overrides: Record<string, unknown> = {}) => ({
      generation: 2,
      nativeRef: "native-ref-1",
      processRef: "process-1",
      state: "parked",
      processState: "running",
      harness: "codex-native",
      executionTarget: "computer-1",
      ...overrides,
    });
    const continuityFor = (
      stored: ReturnType<typeof row>,
      input: { harness: Harness; executionTarget: string },
    ) => {
      const prisma = { nativeSession: { findUnique: vi.fn(async () => stored) } };
      return createNativeSessionStore(prisma as never).continuity({
        botId: "bot-1",
        threadId: "thread-1",
        inputId: "input-1",
        ...input,
      });
    };
    const fresh = { mode: "new", ref: { bindingId: "thread-1", generation: 3 } };

    it.each([
      ["claude-native", "codex-native"],
      ["codex-native", "claude-native"],
    ] as const)(
      "starts a new generation without the %s reference for %s",
      async (stored, requested) => {
        for (const state of [{}, { state: "closed", processState: "stopped" }]) {
          await expect(
            continuityFor(row({ harness: stored, ...state }), {
              harness: requested,
              executionTarget: "computer-1",
            }),
          ).resolves.toEqual(fresh);
        }
      },
    );

    it("starts a new generation when the Computer differs", async () => {
      await expect(
        continuityFor(row(), { harness: "codex-native", executionTarget: "computer-2" }),
      ).resolves.toEqual(fresh);
    });

    it("keeps resuming and reconstructing on the same harness and Computer", async () => {
      const same = { harness: "claude-native", executionTarget: "computer-1" } as const;
      await expect(continuityFor(row({ harness: "claude-native" }), same)).resolves.toEqual({
        mode: "resume",
        ref: { bindingId: "thread-1", generation: 2 },
        inputId: "input-1",
        nativeRef: "native-ref-1",
      });
      const expired = row({ harness: "claude-native", state: "expired", processState: "stopped" });
      await expect(continuityFor(expired, same)).resolves.toMatchObject({
        mode: "reconstruct",
        previous: { bindingId: "thread-1", generation: 2 },
        nativeRef: "native-ref-1",
      });
    });

    it("still refuses an unconfirmed stop whichever harness is requested", async () => {
      await expect(
        continuityFor(row({ processState: "stop_unconfirmed" }), {
          harness: "claude-native",
          executionTarget: "computer-1",
        }),
      ).rejects.toMatchObject({ code: "harness_unavailable" });
    });
  });
});
