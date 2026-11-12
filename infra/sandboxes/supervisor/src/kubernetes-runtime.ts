import type {
  Computer,
  ComputerRuntime,
  ComputerSpec,
  ExecOptions,
  ExecResult,
  WorkerAttempt,
  WorkerGuest,
} from "./computer-runtime.js";

function notImplemented(): never {
  throw new Error("the Kubernetes computer backend is not implemented yet");
}

/**
 * The Kubernetes backend: a `tangow-bot-<id>` pod per computer, deleted on stop and created again
 * on resume, and a `tangowworker<attemptId>` pod per worker. Only its shape exists so far; nothing
 * selects it until it is implemented.
 */
export class KubernetesComputerRuntime implements ComputerRuntime {
  async release(): Promise<string> {
    return notImplemented();
  }

  getComputer(query: {
    id: string;
    owner: { botId: string; spaceId: string };
    screenPort?: string;
  }): Promise<Computer>;
  getComputer(query: { spec: ComputerSpec }): Promise<Computer | undefined>;
  async getComputer(
    _query:
      | { id: string; owner: { botId: string; spaceId: string }; screenPort?: string }
      | { spec: ComputerSpec },
  ): Promise<Computer | undefined> {
    return notImplemented();
  }

  async ensureComputer(
    _spec: ComputerSpec,
    _existing?: Pick<Computer, "id" | "running" | "releaseRef"> & { replace: boolean },
  ): Promise<{ id: string; releaseRef: string; resumed: boolean }> {
    return notImplemented();
  }

  async stopComputer(_id: string): Promise<void> {
    return notImplemented();
  }

  async removeComputer(_id: string, _botId: string): Promise<void> {
    return notImplemented();
  }

  async exec(_id: string, _argv: string[], _options: ExecOptions): Promise<ExecResult> {
    return notImplemented();
  }

  workers = {
    ensure: async (_attempt: WorkerAttempt): Promise<{ id: string }> => notImplemented(),
    destroy: async (_attemptId: string): Promise<{ destroyed: boolean }> => notImplemented(),
    openGuest: async (_id: string, _capability: string): Promise<WorkerGuest | undefined> =>
      notImplemented(),
  };
}
