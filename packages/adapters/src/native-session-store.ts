import type { Continuity, NativeRef } from "@rakazo/adapter-kit";
import type { NativeHarnessChoice } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

type Session = {
  generation: number;
  nativeRef: string | null;
  state: string;
  processState: string;
  harness: string | null;
  executionTarget: string | null;
};

export type NativeSessionStore = {
  continuity(input: {
    botId: string;
    threadId: string;
    harness: NativeHarnessChoice;
    executionTarget: string;
    inputId: string;
  }): Promise<Continuity>;
  record(input: {
    botId: string;
    threadId: string;
    /** The scoped task whose specialist thread this session serves, when the Run has one. */
    scopedTaskId?: string | null;
    ref: NativeRef;
    nativeRef?: string;
    processRef?: string;
    harness: NativeHarnessChoice;
    executionTarget: string;
    continuity: "new" | "resumed" | "reconstructed";
  }): Promise<void>;
  recordReference(input: {
    botId: string;
    threadId: string;
    ref: NativeRef;
    nativeRef: string;
  }): Promise<void>;
  park(input: {
    botId: string;
    threadId: string;
    ref: NativeRef;
    processState?: "running" | "stopped";
  }): Promise<void>;
  close(input: {
    botId: string;
    threadId: string;
    ref: NativeRef;
    processState: "stopped" | "stop_unconfirmed";
  }): Promise<void>;
  expire(input: {
    botId: string;
    threadId: string;
    ref: NativeRef;
    processState: "stopped" | "stop_unconfirmed";
  }): Promise<void>;
  rolloutMissing(input: { botId: string; threadId: string; ref: NativeRef }): Promise<void>;
  stopUnconfirmed(input: { botId: string; threadId: string; ref: NativeRef }): Promise<void>;
  unconfirmed(input: {
    botId: string;
    threadId: string;
  }): Promise<{ ref: NativeRef; processRef: string } | null>;
  confirmStopped(input: { botId: string; threadId: string; ref: NativeRef }): Promise<void>;
};

/** Durable, fenced journal for a native binding. `updatedAt` is not a fence. */
export function createNativeSessionStore(prisma: PrismaClient): NativeSessionStore {
  const event = (botId: string, threadId: string, kind: string) =>
    prisma.lifecycleEvent.create({ data: { botId, threadId, kind, payload: {} } });
  const transition = async (
    input: { botId: string; threadId: string; ref: NativeRef },
    data: Record<string, unknown>,
    kind: string,
  ) => {
    const changed = await prisma.nativeSession.updateMany({
      where: { botId: input.botId, threadId: input.threadId, generation: input.ref.generation },
      data,
    });
    if (changed.count !== 1) throw new Error("native session generation is stale");
    await event(input.botId, input.threadId, kind);
  };
  return {
    async continuity(input) {
      const row = (await prisma.nativeSession.findUnique({
        where: { botId_threadId: { botId: input.botId, threadId: input.threadId } },
        select: {
          generation: true,
          nativeRef: true,
          processRef: true,
          state: true,
          processState: true,
          harness: true,
          executionTarget: true,
        },
      })) as Session | null;
      if (!row) return { mode: "new", ref: { bindingId: input.threadId, generation: 0 } };
      const ref = { bindingId: input.threadId, generation: row.generation };
      // A native reference is only meaningful to the harness and Computer that
      // produced it. Any other pairing starts a fresh native session and never
      // receives the reference; the thread history stays Rakazo's own.
      const compatible =
        row.harness === input.harness && row.executionTarget === input.executionTarget;
      if (compatible && row.state === "parked" && row.processState === "running")
        return {
          mode: "resume",
          ref,
          inputId: input.inputId,
          nativeRef: row.nativeRef ?? undefined,
        };
      if (row.processState === "stop_unconfirmed")
        throw Object.assign(new Error("previous_stop_unconfirmed"), {
          code: "harness_unavailable",
        });
      if (compatible && row.nativeRef)
        return {
          mode: "reconstruct",
          previous: ref,
          reason: "parked_process_missing",
          inputId: input.inputId,
          nativeRef: row.nativeRef,
        };
      return { mode: "new", ref: { bindingId: input.threadId, generation: row.generation + 1 } };
    },
    async record(input) {
      const attached = {
        nativeRef: input.nativeRef,
        processRef: input.processRef,
        harness: input.harness,
        executionTarget: input.executionTarget,
        state: "attached",
        processState: "running",
        // The reconciler reaches a terminal task's session through this link.
        ...(input.scopedTaskId ? { scopedTaskId: input.scopedTaskId } : {}),
      };
      if (input.continuity === "new") {
        if (input.ref.generation === 0) {
          await prisma.nativeSession.upsert({
            where: { botId_threadId: { botId: input.botId, threadId: input.threadId } },
            create: {
              botId: input.botId,
              threadId: input.threadId,
              generation: 0,
              ...attached,
            },
            // `ensureBinding` may have inserted generation zero before the runtime
            // reports its first session event.  Preserve that binding while filling
            // the durable runtime state instead of leaving its defaults in place.
            update: attached,
          });
        } else {
          const changed = await prisma.nativeSession.updateMany({
            where: {
              botId: input.botId,
              threadId: input.threadId,
              generation: input.ref.generation - 1,
            },
            data: { generation: input.ref.generation, ...attached },
          });
          if (changed.count !== 1) throw new Error("native session generation is stale");
        }
        await event(input.botId, input.threadId, "attach");
        return;
      }
      const previous =
        input.continuity === "reconstructed" ? input.ref.generation - 1 : input.ref.generation;
      const changed = await prisma.nativeSession.updateMany({
        where: { botId: input.botId, threadId: input.threadId, generation: previous },
        data: { generation: input.ref.generation, ...attached },
      });
      if (changed.count !== 1) throw new Error("native session generation is stale");
      await event(
        input.botId,
        input.threadId,
        input.continuity === "resumed" ? "resume" : "reconstruct",
      );
    },
    async park(input) {
      await transition(
        input,
        { state: "parked", processState: input.processState ?? "running" },
        "park",
      );
    },
    async close(input) {
      await transition(input, { state: "closed", processState: input.processState }, "close");
    },
    async expire(input) {
      await transition(input, { state: "expired", processState: input.processState }, "expire");
    },
    async rolloutMissing(input) {
      await transition(
        input,
        { state: "expired", processState: "stopped" },
        "resume_rollout_missing",
      );
    },
    async recordReference(input) {
      const changed = await prisma.nativeSession.updateMany({
        where: { botId: input.botId, threadId: input.threadId, generation: input.ref.generation },
        data: { nativeRef: input.nativeRef },
      });
      if (changed.count !== 1) throw new Error("native session generation is stale");
    },
    async stopUnconfirmed(input) {
      await transition(
        input,
        { state: "expired", processState: "stop_unconfirmed" },
        "stop_unconfirmed",
      );
    },
    async unconfirmed(input) {
      const row = await prisma.nativeSession.findUnique({
        where: { botId_threadId: input },
        select: { generation: true, processRef: true, processState: true },
      });
      return row?.processState === "stop_unconfirmed" && row.processRef
        ? {
            ref: { bindingId: input.threadId, generation: row.generation },
            processRef: row.processRef,
          }
        : null;
    },
    async confirmStopped(input) {
      await transition(input, { state: "closed", processState: "stopped" }, "stop_confirmed");
    },
  };
}
