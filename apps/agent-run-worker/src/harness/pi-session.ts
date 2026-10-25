import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type RelayStream = NonNullable<ProviderConfig["streamSimple"]>;

const RELAY_PLACEHOLDER_KEY = "worker-relay-placeholder";

/** Pi's model runtime with a placeholder key: the controller's relay holds the real one. */
export async function relayModelRuntime(
  model: Parameters<RelayStream>[0],
  streamSimple?: RelayStream,
) {
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async (provider) =>
        provider === model.provider ? { type: "api_key", key: RELAY_PLACEHOLDER_KEY } : undefined,
      list: async () => [{ providerId: model.provider, type: "api_key" }],
      modify: async () => {
        throw new Error("Worker relay credentials are fixed");
      },
      delete: async () => undefined,
    },
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(model.provider, {
    baseUrl: "http://relay.invalid/v1",
    api: model.api,
    // An OAuth-only provider (ChatGPT) has no API-key method for the placeholder otherwise.
    apiKey: RELAY_PLACEHOLDER_KEY,
    models: [model],
    ...(streamSimple ? { streamSimple } : {}),
  });
  return modelRuntime;
}
