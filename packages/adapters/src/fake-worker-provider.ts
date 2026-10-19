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
  | { op: "ensureVolume"; name: string };

/** Deterministic in-memory workers. Records every call; tests may delete from `live`. */
export class FakeWorkerProvider implements WorkerProvider {
  readonly calls: FakeWorkerCall[] = [];
  /** Live VMs by provider ref. */
  readonly live = new Map<string, WorkerSpec>();

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
    const providerRef = `fake-worker-${spec.attemptId}`;
    this.live.set(providerRef, spec);
    return { providerRef };
  }

  async prepare(providerRef: string, _spec: WorkerSpec, _context: AdapterContext): Promise<void> {
    this.calls.push({ op: "prepare", providerRef });
    if (this.options.failPrepare) throw this.options.failPrepare;
  }

  async destroy(
    target: { attemptId: string; providerRef: string | null },
    _context: AdapterContext,
  ): Promise<"destroyed" | "absent"> {
    const ref =
      target.providerRef ??
      [...this.live].find(([, spec]) => spec.attemptId === target.attemptId)?.[0];
    const result = ref && this.live.delete(ref) ? "destroyed" : "absent";
    this.calls.push({ op: "destroy", ...target, result });
    return result;
  }

  async ensureVolume(
    input: { name: string },
    _context: AdapterContext,
  ): Promise<{ providerRef: string }> {
    this.calls.push({ op: "ensureVolume", name: input.name });
    return { providerRef: `fake-volume-${input.name}` };
  }
}
