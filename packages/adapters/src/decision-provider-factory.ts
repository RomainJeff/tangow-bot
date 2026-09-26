import type { DecisionProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { toStringRecord } from "./memory-provider-factory.js";
import type { EncryptedSecretStore } from "./secrets.js";
import {
  createTypeSafeDecisionProvider,
  prepareTypeSafeDecisionConnection,
  TYPESAFE_DECISION_PROVIDER_ID,
  typesafeDecisionRequiresDeploymentOwner,
} from "./typesafe-decision.js";

export interface DecisionProviderResolver {
  /** Null when the Space has no usable decision connection; the run carries on without one. */
  resolve(spaceId: string): Promise<DecisionProvider | null>;
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
    TYPESAFE_DECISION_PROVIDER_ID,
    {
      requiresDeploymentOwner: typesafeDecisionRequiresDeploymentOwner,
      prepare: prepareTypeSafeDecisionConnection,
      create: createTypeSafeDecisionProvider,
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

  async resolve(spaceId: string): Promise<DecisionProvider | null> {
    const config = await this.prisma.spaceDecisionConfig.findUnique({
      where: { spaceId },
      include: { secret: true },
    });
    if (!config || !DECISION_PROVIDER_ADAPTERS.has(config.provider)) return null;
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
