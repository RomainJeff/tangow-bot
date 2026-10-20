import type {
  AdapterContext,
  AdapterDescriptor,
  WorkerCapabilities,
  WorkerProvider,
  WorkerSpec,
} from "@rakazo/adapter-kit";

export type FakeWorkerCall =
  | { op: "ensure"; spec: WorkerSpec }
  | { op: "prepare"; providerRef: string }
  | {
      op: "destroy";
      attemptId: string;
      providerRef: string | null;
      result: "destroyed" | "absent";
    }
  | { op: "ensureVolume"; name: string }
  | { op: "deleteVolume"; name: string };

/** Deterministic in-memory workers. Records every call; tests may delete from `live`. */
export class FakeWorkerProvider implements WorkerProvider {
  readonly calls: FakeWorkerCall[] = [];
  /** Live VMs by provider ref. */
  readonly live = new Map<string, WorkerSpec>();
  /** Volume names the provider holds. */
  readonly volumes = new Set<string>();
  /** Thrown by every `destroy` while set: the provider cannot confirm destruction. */
  failDestroy: Error | null = null;
  private ensureHold: Promise<void> | null = null;

  constructor(private readonly options: { readOnlyMounts?: boolean; failPrepare?: Error } = {}) {}

  describe(): AdapterDescriptor<WorkerCapabilities> {
    return {
      id: "fake-worker",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { readOnlyMounts: this.options.readOnlyMounts ?? false },
    };
  }

  async ensure(spec: WorkerSpec, _context: AdapterContext): Promise<{ providerRef: string }> {
    this.calls.push({ op: "ensure", spec });
    await this.ensureHold;
    const providerRef = `fake-worker-${spec.attemptId}`;
    this.live.set(providerRef, spec);
    return { providerRef };
  }

  /** Holds every `ensure` before its VM exists, until the returned function is called. */
  holdEnsure(): () => void {
    let release!: () => void;
    this.ensureHold = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      this.ensureHold = null;
      release();
    };
  }

  async prepare(providerRef: string, _spec: WorkerSpec, _context: AdapterContext): Promise<void> {
    this.calls.push({ op: "prepare", providerRef });
    if (this.options.failPrepare) throw this.options.failPrepare;
  }

  async destroy(
    target: { attemptId: string; providerRef: string | null },
    _context: AdapterContext,
  ): Promise<"destroyed" | "absent"> {
    if (this.failDestroy) throw this.failDestroy;
    const tagged = [...this.live].filter(([, spec]) => spec.attemptId === target.attemptId);
    for (const [ref] of tagged) this.live.delete(ref);
    const result = tagged.length > 0 ? "destroyed" : "absent";
    this.calls.push({ op: "destroy", ...target, result });
    return result;
  }

  async ensureVolume(
    input: { name: string },
    _context: AdapterContext,
  ): Promise<{ providerRef: string }> {
    this.calls.push({ op: "ensureVolume", name: input.name });
    this.volumes.add(input.name);
    return { providerRef: `fake-volume-${input.name}` };
  }

  async listVolumes(_context: AdapterContext): Promise<string[]> {
    return [...this.volumes];
  }

  async deleteVolume(input: { name: string }, _context: AdapterContext): Promise<void> {
    this.calls.push({ op: "deleteVolume", name: input.name });
    this.volumes.delete(input.name);
  }
}
