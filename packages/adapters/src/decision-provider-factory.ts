import type { DecisionProvider } from "@tangow/adapter-kit";
import type { PrismaClient } from "@tangow/db";
import { toStringRecord } from "./memory-provider-factory.js";
import {
  createOpenRouterDecisionProvider,
  OPENROUTER_DECISION_PROVIDER_ID,
  openRouterDecisionRequiresDeploymentOwner,
  prepareOpenRouterDecisionConnection,
} from "./openrouter-decision.js";
import type { EncryptedSecretStore } from "./secrets.js";

export interface DecisionProviderResolver {
  /**
   * Null when the Space has no usable decision connection, or `userId` did not set it up; the
   * run carries on without one.
   */
  resolve(spaceId: string, userId: string): Promise<DecisionProvider | null>;
}

interface DecisionProviderAdapter {
  requiresDeploymentOwner(settings: Record<string, string>): boolean;
  prepare(
    settings: Record<string, string>,
    credentials: Record<string, string>,
  ): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }>;
  create(settings: Record<string, string>, credentials: Record<string, string>): DecisionProvider;
}

const DECISION_PROVIDER_ADAPTERS: ReadonlyMap<string, DecisionProviderAdapter> = new Map([
  [
    OPENROUTER_DECISION_PROVIDER_ID,
    {
      requiresDeploymentOwner: openRouterDecisionRequiresDeploymentOwner,
      prepare: prepareOpenRouterDecisionConnection,
      create: createOpenRouterDecisionProvider,
    },
  ],
]);

function decisionProviderAdapter(provider: string): DecisionProviderAdapter {
  const adapter = DECISION_PROVIDER_ADAPTERS.get(provider);
  if (!adapter) throw new Error(`Unknown decision provider "${provider}".`);
  return adapter;
}

export function decisionProviderRequiresDeploymentOwner(
  provider: string,
  settings: Record<string, string>,
): boolean {
  return decisionProviderAdapter(provider).requiresDeploymentOwner(settings);
}

export async function prepareDecisionProviderConnection(input: {
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
}): Promise<{
  provider: string;
  settings: Record<string, string>;
  credentials: Record<string, string>;
}> {
  const prepared = await decisionProviderAdapter(input.provider).prepare(
    input.settings,
    input.credentials,
  );
  return { provider: input.provider, ...prepared };
}

export function createDecisionProvider(
  provider: string,
  settings: Record<string, string>,
  credentials: Record<string, string>,
): DecisionProvider {
  return decisionProviderAdapter(provider).create(settings, credentials);
}

export class SpaceDecisionProviderResolver implements DecisionProviderResolver {
  constructor(
    private readonly prisma: Pick<PrismaClient, "spaceDecisionConfig" | "deploymentSettings">,
    private readonly secrets: EncryptedSecretStore,
  ) {}

  async resolve(spaceId: string, userId: string): Promise<DecisionProvider | null> {
    const config = await this.prisma.spaceDecisionConfig.findUnique({
      where: { spaceId },
      include: { secret: true },
    });
    if (!config || config.userId !== userId || !DECISION_PROVIDER_ADAPTERS.has(config.provider)) {
      return null;
    }
    const settings = toStringRecord(config.settings);
    if (decisionProviderRequiresDeploymentOwner(config.provider, settings)) {
      const deployment = await this.prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { ownerUserId: true },
      });
      if (!deployment?.ownerUserId || deployment.ownerUserId !== config.userId) return null;
    }
    const credentials = toStringRecord(
      JSON.parse(this.secrets.load(config.secret.ciphertext, config.secret.id)),
    );
    return createDecisionProvider(config.provider, settings, credentials);
  }
}
