import type { WorkerProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { E2BWorkerProvider } from "./e2b-worker.js";
import type { GuestConnector } from "./runtime-worker/launcher.js";
import { createRunWorkers } from "./runtime-worker/runtime.js";
import { resolveSandboxProvider } from "./sandbox-provider-env.js";
import { createWorkerLifecycle } from "./worker-lifecycle.js";

export type WorkerProviderConfig = { kind: "e2b"; apiKey: string; template: string };

/** The template `apps/agent-run-worker/template` builds for the default harness. */
const DEFAULT_WORKER_TEMPLATE = "rakazo-worker-pi-native";
const RECONCILE_BATCH = 10;

/**
 * An E2B deployment runs its bots in E2B workers; `WORKER_TEMPLATE` only renames their guest
 * image. E2B reads its self-hosted endpoint from its own `E2B_DOMAIN` or `E2B_API_URL`. Every
 * other computer provider keeps runs in process.
 */
export function resolveWorkerProvider(
  source: NodeJS.ProcessEnv = process.env,
): WorkerProviderConfig | null {
  const apiKey = source.E2B_API_KEY?.trim();
  if (resolveSandboxProvider(source) !== "e2b" || !apiKey) return null;
  return {
    kind: "e2b",
    apiKey,
    template: source.WORKER_TEMPLATE?.trim() || DEFAULT_WORKER_TEMPLATE,
  };
}

export function createWorkerProvider(
  config: WorkerProviderConfig | null,
): (WorkerProvider & GuestConnector) | null {
  return config
    ? new E2BWorkerProvider({ apiKey: config.apiKey, template: config.template })
    : null;
}

/**
 * Every deployment reconciles expired home moves. A provider also enables worker routing,
 * orphan worker release and volume deletion.
 */
export function composeWorkers(
  prisma: PrismaClient,
  provider: (WorkerProvider & GuestConnector) | null,
) {
  const lifecycle = createWorkerLifecycle({ prisma, provider });
  return {
    lifecycle,
    runWorkers: provider
      ? createRunWorkers({ prisma, lifecycle, connector: provider, screensByPath: true })
      : undefined,
    async reconcileWorkers(signal: AbortSignal) {
      const context = {
        operationId: "workers.reconcile",
        traceId: "workers.reconcile",
        spaceId: "",
        userId: "",
        signal,
      };
      const counts = await lifecycle.reconcile({ limit: RECONCILE_BATCH }, context);
      if (counts.failed > 0) getLogger().error("worker reconciliation", counts);
      const swept = await lifecycle.sweepVolumes(context);
      if (swept.failed > 0) getLogger().error("volume sweep", swept);
    },
  };
}
