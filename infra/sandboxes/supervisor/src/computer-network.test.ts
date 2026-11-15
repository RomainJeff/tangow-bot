import type * as NodeFsPromises from "node:fs/promises";
import path from "node:path";
import { resolveSupervisorToken } from "@tangow/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_IMAGE, COMPUTER_USER, computerNetworkNameFor } from "./computer-spec.js";

const mocks = vi.hoisted(() => ({
  docker: {
    version: vi.fn(),
    getImage: vi.fn(),
    getContainer: vi.fn(),
    getNetwork: vi.fn(),
    listContainers: vi.fn(),
    createContainer: vi.fn(),
    createNetwork: vi.fn(),
  },
}));
vi.mock("dockerode", () => ({
  default: class {
    version = mocks.docker.version;
    getImage = mocks.docker.getImage;
    getContainer = mocks.docker.getContainer;
    getNetwork = mocks.docker.getNetwork;
    listContainers = mocks.docker.listContainers;
    createContainer = mocks.docker.createContainer;
    createNetwork = mocks.docker.createNetwork;
  },
}));
vi.mock("./home-ownership.js", () => ({ assertComputerHomeWritable: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  mkdir: vi.fn(),
}));

const SUPERVISOR_ID = "supervisor-id";
const WEB_ID = "web-id";
const supervisorInfo = {
  Id: SUPERVISOR_ID,
  Mounts: [],
  Config: { Labels: { "com.docker.compose.project": "tangow" } },
  NetworkSettings: { Networks: { tangow_default: {} } },
};

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("HOSTNAME", SUPERVISOR_ID);
  vi.stubEnv("DATA_DIR", "/tmp/tangow-network-test");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "isolated");
});

describe("isolated computer network on provision", () => {
  const network = computerNetworkNameFor("bot");

  async function provision(existing?: { id: string }) {
    const { skillsBindsFor, supervisorApp } = await import("./index.js");
    const homePath = path.join(process.env.DATA_DIR!, "homes", "bot");
    const skillsBinds = skillsBindsFor(
      process.env.DATA_DIR!,
      { spaceId: "space", userId: "user" },
      (p) => p,
    );
    const connect = vi.fn().mockResolvedValue(undefined);
    mocks.docker.getNetwork.mockReturnValue({
      inspect: vi.fn().mockResolvedValue({ Containers: {} }),
      connect,
    });
    mocks.docker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "image" }) });
    mocks.docker.createNetwork.mockResolvedValue({ remove: vi.fn() });
    mocks.docker.listContainers.mockImplementation(
      async (options: { filters: { label: string[] } }) =>
        options.filters.label.some((label) => label.startsWith("tangow.botId="))
          ? existing
            ? [{ Id: existing.id }]
            : []
          : [{ Id: WEB_ID }],
    );
    const computer = {
      id: "computer",
      inspect: vi.fn().mockResolvedValue({
        Image: "image",
        Config: {
          User: COMPUTER_USER,
          Labels: { "tangow.managed": "true", "tangow.botId": "bot", "tangow.spaceId": "space" },
        },
        HostConfig: {
          NetworkMode: network,
          Binds: [`${homePath}:/home/tangow`, ...skillsBinds],
        },
        State: { Running: false },
      }),
      start: vi.fn().mockResolvedValue(undefined),
    };
    mocks.docker.getContainer.mockImplementation((id: string) =>
      id === SUPERVISOR_ID ? { inspect: async () => supervisorInfo } : computer,
    );
    mocks.docker.createContainer.mockResolvedValue(computer);

    const response = await supervisorApp.request("/computers", {
      method: "POST",
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "content-type": "application/json",
        "x-tangow-bot-id": "bot",
        "x-tangow-space-id": "space",
      },
      body: JSON.stringify({ botId: "bot", spaceId: "space", userId: "user", homePath }),
    });
    return { response, connect };
  }

  it.each([
    { path: "resume", existing: { id: "computer" }, resumed: true },
    { path: "create", existing: undefined, resumed: false },
  ])("joins the supervisor to the computer network on $path", async ({ existing, resumed }) => {
    const { response, connect } = await provision(existing);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resumed, image: COMPUTER_IMAGE });
    expect(connect.mock.calls).toEqual([[{ Container: SUPERVISOR_ID }]]);
  });
});
