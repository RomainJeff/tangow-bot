import type { ProviderConfig, ResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PiAgentRuntimeOptions } from "@rakazo/adapters/pi-runtime";

type Agent = Parameters<NonNullable<PiAgentRuntimeOptions["bindSession"]>>[0];
type RelayStream = NonNullable<ProviderConfig["streamSimple"]>;

/** Pi's model runtime with a placeholder key: the controller's relay holds the real one. */
export async function relayModelRuntime(
  model: Parameters<RelayStream>[0],
  streamSimple?: RelayStream,
) {
  const modelRuntime = await ModelRuntime.create({
    credentials: {
      read: async (provider) =>
        provider === model.provider
          ? { type: "api_key", key: "worker-relay-placeholder" }
          : undefined,
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
    models: [model],
    ...(streamSimple ? { streamSimple } : {}),
  });
  return modelRuntime;
}

/** Session state comes only from the controller. No credentials or resources come from disk. */
export async function piSession(agent: Agent, cwd: string, resources: ResourceLoader) {
  const model = agent.state.model;
  if (!model) throw new Error("The relay model is missing");
  const modelRuntime = await relayModelRuntime(model);
  const sessionManager = SessionManager.inMemory(cwd);
  for (const message of agent.state.messages) {
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "toolResult"
    )
      throw new Error(`Cannot replay ${message.role}`);
    sessionManager.appendMessage(message);
  }
  const session = new AgentSession({
    agent,
    cwd,
    resourceLoader: resources,
    modelRuntime,
    sessionManager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      images: { autoResize: false },
    }),
    baseToolsOverride: Object.fromEntries(agent.state.tools.map((tool) => [tool.name, tool])),
    initialActiveToolNames: agent.state.tools.map((tool) => tool.name),
    allowedToolNames: agent.state.tools.map((tool) => tool.name),
  });
  return {
    prompt: (text: string, images: Parameters<Agent["prompt"]>[1]) =>
      session.prompt(text, { images, expandPromptTemplates: false }),
    dispose: () => session.dispose(),
  };
}
