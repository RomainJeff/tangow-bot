import type {
  AgentSkillCatalogEntry,
  BotSharing,
  Connection,
  ConnectionCatalogItem,
  McpServer,
} from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import {
  declareApp,
  givableSkills,
  shareableApps,
  shareWithPerson,
  shareWithSpace,
  showsTeamMemory,
} from "./bot-sharing.js";

const gmail = { kind: "app", connectorId: "composio", provider: "GMAIL" } as const;
const linear = { kind: "mcp", serverId: "server-linear" } as const;
const connection = (partial: Partial<Connection>) =>
  ({
    connectorId: "composio",
    provider: "GMAIL",
    displayName: "me@gmail",
    ...partial,
  }) as Connection;

describe("shareableApps", () => {
  it("lists each connected app once by its catalog name, then the servers given to the bot", () => {
    const apps = shareableApps(
      [
        connection({ status: "connected" }),
        connection({ status: "connected", displayName: "work@gmail" }),
        connection({ provider: "SLACK", status: "revoked" }),
      ],
      [{ connectorId: "composio", slug: "GMAIL", name: "Gmail" } as ConnectionCatalogItem],
      {
        all: [
          { id: "server-linear", name: "Linear" },
          { id: "server-other", name: "Other" },
        ] as McpServer[],
        given: new Set(["server-linear"]),
      },
      [],
      "Deleted",
    );
    expect(apps.map((app) => [app.name, app.need])).toEqual([
      ["Gmail", gmail],
      ["Linear", linear],
    ]);
  });

  it("keeps a declared app the owner disconnected, and a deleted server, so they can be unticked", () => {
    const apps = shareableApps([], [], { all: [], given: new Set() }, [gmail, linear], "Deleted");
    expect(apps.map((app) => app.name)).toEqual(["GMAIL", "Deleted"]);
  });
});

describe("who a bot is shared with", () => {
  it("ticks people one by one, and nobody ticked makes it private again", () => {
    const one = shareWithPerson(shareWithSpace(false), "grace", true);
    expect(one).toEqual({ visibility: "people", userIds: ["grace"] });
    expect(shareWithPerson(one, "alan", true).userIds).toEqual(["grace", "alan"]);
    expect(shareWithPerson(one, "grace", false)).toEqual({ visibility: "private", userIds: [] });
  });

  it("starts from nobody when ticking a person on a bot shared with the whole Space", () => {
    expect(shareWithPerson(shareWithSpace(true), "grace", true)).toEqual({
      visibility: "people",
      userIds: ["grace"],
    });
  });

  it("declares and drops an app without changing who it is shared with", () => {
    const sharing: BotSharing = { visibility: "people", userIds: ["grace"], connectors: [] };
    const app = { key: "mcp:server-linear", name: "Linear", need: linear };
    const declared = declareApp(sharing, app, true);
    expect(declared).toEqual({ ...sharing, connectors: [linear] });
    expect(declareApp(declared, app, false)).toEqual(sharing);
  });
});

describe("givableSkills", () => {
  it("offers only the owner's own skills that are not turned off", () => {
    const skill = (partial: Partial<AgentSkillCatalogEntry>) =>
      ({
        id: partial.name,
        source: "user",
        availability: "all",
        ...partial,
      }) as AgentSkillCatalogEntry;
    const skills = [
      skill({ name: "changelog" }),
      skill({ name: "off", availability: "disabled" }),
      skill({ name: "builtin", source: "builtin" }),
    ];
    expect(givableSkills(skills).map((entry) => entry.name)).toEqual(["changelog"]);
  });
});

describe("showsTeamMemory", () => {
  it("shows on a shared bot, and on a private one only while it still has team documents", () => {
    expect(showsTeamMemory({ visibility: "space" }, [])).toBe(true);
    expect(showsTeamMemory({ visibility: "private" }, [{}])).toBe(true);
    expect(showsTeamMemory({ visibility: "private" }, [])).toBe(false);
  });
});
