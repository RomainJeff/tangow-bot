import { beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({
  calls: [] as Array<{ proc: string; input: unknown }>,
  answers: {} as Record<string, () => unknown>,
}));

vi.mock("./api", () => ({
  selectedSpaceId: () => "space-1",
  rpc: vi.fn(async (proc: string, input: unknown) => {
    server.calls.push({ proc, input });
    const answer = server.answers[proc];
    if (!answer) throw new Error(`unexpected ${proc}`);
    return answer();
  }),
}));

import { readShareableApps, readShareSheet, saveSharing } from "./bot-share";

const skill = (enabled: boolean) => ({
  id: "skill-changelog",
  name: "Changelog",
  source: "user",
  availability: "all",
  visibleBotIds: enabled ? ["bot-1"] : [],
});

describe("the mobile share sheet", () => {
  beforeEach(() => {
    server.calls = [];
    server.answers = {};
  });

  it("fails, for its Retry, when the bot itself can't be read, and opens once it can", async () => {
    server.answers.me = () => ({ userId: "owner" });
    const opened = readShareSheet("bot-1");
    await expect(opened).rejects.toThrow("unexpected bots/get");
    server.answers["bots/get"] = () => ({ id: "bot-1", name: "Writer", spaceId: "space-1" });
    server.answers["bots/sharing"] = () => ({ visibility: "private", userIds: [], connectors: [] });
    server.answers["spaces/members"] = () => ({
      members: [
        { userId: "owner", name: "Ada" },
        { userId: "grace", name: "Grace" },
      ],
    });
    server.answers["agentSkills/list"] = () => [skill(false)];
    const sheet = await readShareSheet("bot-1");
    expect(sheet.bot).toEqual({ name: "Writer", spaceId: "space-1" });
    expect(sheet.people.map((member) => member.userId)).toEqual(["grace"]);
  });

  it("saves through bots/share and reads the skills again, since sharing changes which count", async () => {
    server.answers["bots/share"] = () => ({
      visibility: "people",
      userIds: ["grace"],
      connectors: [],
    });
    server.answers["agentSkills/list"] = () => [skill(false)];
    const saved = await saveSharing("bot-1", { visibility: "people", userIds: ["grace"] });
    expect(server.calls[0]).toEqual({
      proc: "bots/share",
      input: { botId: "bot-1", visibility: "people", userIds: ["grace"] },
    });
    expect(saved.sharing.userIds).toEqual(["grace"]);
    expect(saved.skills?.map((entry) => entry.visibleBotIds)).toEqual([[]]);
  });

  it("keeps the shown skills when the reread fails after a save that landed", async () => {
    server.answers["bots/share"] = () => ({ visibility: "space", userIds: [], connectors: [] });
    const saved = await saveSharing("bot-1", { visibility: "space", userIds: [] });
    expect(saved).toEqual({
      sharing: { visibility: "space", userIds: [], connectors: [] },
      skills: null,
    });
  });

  it("lists the owner's apps and the MCP servers given to the bot when the catalog fails", async () => {
    server.answers["connections/list"] = () => [
      { connectorId: "composio", provider: "GMAIL", displayName: "me@gmail", status: "connected" },
    ];
    server.answers["mcp/servers/list"] = () => [
      { id: "server-linear", name: "Linear" },
      { id: "server-other", name: "Other" },
    ];
    server.answers["mcp/assignments/list"] = () => [{ serverId: "server-linear" }];
    const apps = await readShareableApps("bot-1", []);
    expect(apps.map((app) => app.name)).toEqual(["me@gmail", "Linear"]);
  });

  it("builds no list when the MCP servers can't be read, rather than calling a declared one deleted", async () => {
    server.answers["connections/list"] = () => [];
    server.answers["mcp/assignments/list"] = () => [{ serverId: "server-linear" }];
    await expect(
      readShareableApps("bot-1", [{ kind: "mcp", serverId: "server-linear" }]),
    ).rejects.toThrow("unexpected mcp/servers/list");
  });
});
