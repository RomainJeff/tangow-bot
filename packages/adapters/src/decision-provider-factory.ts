import type { DecisionProvider } from "@rakazo/adapter-kit";
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
