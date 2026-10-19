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

/** The controller's view of a worker, read from the database. Never on the wire. */
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

/** What the controller accepts from a guest. */
export const GuestMessageV1Schema = WorkerEventV1Schema;
export type GuestMessageV1 = WorkerEventV1;

/** What a guest accepts from the controller. */
export const ControllerMessageV1Schema = z.discriminatedUnion("kind", [
  WorkerStartV1Schema,
  WorkerCancelV1Schema,
]);
export type ControllerMessageV1 = z.infer<typeof ControllerMessageV1Schema>;

export type WireParse<T> =
  | { ok: true; message: T }
  | { ok: false; reason: "unsupported_version" | "invalid" };

/** Never throws: a message from a newer or hostile peer is refused, not coerced. */
function parseWire<T>(schema: z.ZodType<T>, json: unknown): WireParse<T> {
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, message: parsed.data };
  const version =
    typeof json === "object" && json !== null && "version" in json ? json.version : undefined;
  return {
    ok: false,
    reason: version !== undefined && version !== 1 ? "unsupported_version" : "invalid",
  };
}

export function parseGuestMessage(json: unknown): WireParse<GuestMessageV1> {
  return parseWire(GuestMessageV1Schema, json);
}

export function parseControllerMessage(json: unknown): WireParse<ControllerMessageV1> {
  return parseWire(ControllerMessageV1Schema, json);
}

type NoFunctions<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends object
    ? { [K in keyof T]: NoFunctions<T[K]> }
    : T;
type WireMessageV1 = GuestMessageV1 | ControllerMessageV1;
// Fails to compile once any message field can hold a callable.
const _wireCarriesNoCallable: WireMessageV1 extends NoFunctions<WireMessageV1> ? true : never =
  true;
