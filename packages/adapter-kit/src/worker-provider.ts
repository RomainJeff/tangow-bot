import type { VolumeAccess } from "@rakazo/contracts";
import type { AdapterContext, AdapterDescriptor } from "./types.js";

export interface WorkerCapabilities {
  /** Whether the provider enforces a read-only mount. A right it cannot enforce is refused. */
  readOnlyMounts: boolean;
}

/** One run attempt's VM, already authorized by the controller. */
export interface WorkerSpec {
  /** Tags the VM at the provider, so a VM whose ref was never recorded can still be found. */
  attemptId: string;
  runId: string;
  botId: string;
  mounts: Array<{ volumeRef: string; path: string; access: VolumeAccess }>;
  /** The provider removes the VM after this long, whatever the controller does. */
  ttlSeconds: number;
  /**
   * `ensure` must not create the VM later than this after it was called. Past it, a VM absent for
   * this attempt's tag is taken as never created and its writer leases free.
   */
  ensureTimeoutSeconds: number;
}

/**
 * Temporary run workers, separate from computers: a worker has no screen and an MCP-only run needs
 * one without a computer. There is deliberately no way to delete a volume here.
 */
export interface WorkerProvider {
  describe(): AdapterDescriptor<WorkerCapabilities>;
  /**
   * Creates the VM tagged with `spec.attemptId`, called once per attempt. Must not create it after
   * `spec.ensureTimeoutSeconds`.
   */
  ensure(spec: WorkerSpec, context: AdapterContext): Promise<{ providerRef: string }>;
  /** Fallible setup once the ref is recorded: mounts visible, runner reachable. Idempotent. */
  prepare(providerRef: string, spec: WorkerSpec, context: AdapterContext): Promise<void>;
  /**
   * Destroys every VM tagged with `attemptId`, with or without a ref. None left to destroy is
   * `absent`, not an error.
   */
  destroy(
    target: { attemptId: string; providerRef: string | null },
    context: AdapterContext,
  ): Promise<"destroyed" | "absent">;
  /** Creates the volume named `name`, or returns the existing one. */
  ensureVolume(input: { name: string }, context: AdapterContext): Promise<{ providerRef: string }>;
}
