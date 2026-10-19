import { VolumeAccess, WorkerState } from "@rakazo/contracts";
import { z } from "zod";

/** Every message names one run attempt and the fence it claimed. */
const WorkerIdentity = z.strictObject({
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  fence: z.number().int().positive(),
});

/** What the guest learns about a mount: where and how. Never which volume, owner or host path. */
export const GuestMountSchema = z.strictObject({
  path: z.string().startsWith("/"),
  scope: z.enum(["private", "shared"]),
  access: VolumeAccess,
});
export type GuestMount = z.infer<typeof GuestMountSchema>;

/** Controller to guest, once the worker is ready. P2 adds the callback-free run input. */
export const WorkerStartV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("worker.start"),
  worker: WorkerIdentity,
  workspace: z.strictObject({
    cwd: z.string().startsWith("/"),
    mounts: z.array(GuestMountSchema).max(2),
  }),
  computer: z.enum(["none", "on_use"]),
});
export type WorkerStartV1 = z.infer<typeof WorkerStartV1Schema>;

/** Controller to guest: stop the run. The controller destroys the VM whatever the guest does. */
export const WorkerCancelV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("worker.cancel"),
  worker: WorkerIdentity,
});
export type WorkerCancelV1 = z.infer<typeof WorkerCancelV1Schema>;

/** The controller's view of a worker, read from the database, never from the guest. */
export const WorkerStatusV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("worker.status"),
  worker: WorkerIdentity,
  state: WorkerState,
  providerRef: z.string().nullable(),
  active: z.boolean(),
});
export type WorkerStatusV1 = z.infer<typeof WorkerStatusV1Schema>;

/** Guest to controller. P2 owns the payloads, sequencing and acknowledgement. */
export const WorkerEventV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("worker.event"),
  worker: WorkerIdentity,
  payload: z.unknown(),
});
export type WorkerEventV1 = z.infer<typeof WorkerEventV1Schema>;

export const WorkerMessageV1Schema = z.discriminatedUnion("kind", [
  WorkerStartV1Schema,
  WorkerCancelV1Schema,
  WorkerStatusV1Schema,
  WorkerEventV1Schema,
]);
export type WorkerMessageV1 = z.infer<typeof WorkerMessageV1Schema>;

export type WorkerMessageParse =
  | { ok: true; message: WorkerMessageV1 }
  | { ok: false; reason: "unsupported_version" | "invalid" };

/** Never throws: a message from a newer or hostile peer is refused, not coerced. */
export function parseWorkerMessage(json: unknown): WorkerMessageParse {
  const parsed = WorkerMessageV1Schema.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data };
  const version =
    typeof json === "object" && json !== null && "version" in json ? json.version : undefined;
  return {
    ok: false,
    reason: version !== undefined && version !== 1 ? "unsupported_version" : "invalid",
  };
}

type NoFunctions<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends object
    ? { [K in keyof T]: NoFunctions<T[K]> }
    : T;
// Fails to compile once any message field can hold a callable.
const _wireCarriesNoCallable: WorkerMessageV1 extends NoFunctions<WorkerMessageV1> ? true : never =
  true;
