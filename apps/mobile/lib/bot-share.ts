import type {
  AgentSkillCatalogEntry,
  BotMcpServer,
  BotSharing,
  Connection,
  ConnectionCatalogItem,
  McpServer,
  SpaceMembers,
} from "@rakazo/contracts";
import type { ShareableApp } from "@rakazo/core";
import { givableSkills, shareableApps } from "@rakazo/core";
import { rpc } from "./api";
import { t } from "./i18n";

/** Who the bot is shared with, who else is in its Space, and the owner's skills it can be given. */
export type ShareSheet = {
  sharing: BotSharing;
  people: SpaceMembers["members"];
  skills: AgentSkillCatalogEntry[];
};

export async function readShareSheet(
  bot: { id: string; spaceId: string },
  userId: string,
): Promise<ShareSheet> {
  const [sharing, view, catalog] = await Promise.all([
    rpc<BotSharing>("bots/sharing", { botId: bot.id }),
    rpc<SpaceMembers>("spaces/members", { spaceId: bot.spaceId }),
    rpc<AgentSkillCatalogEntry[]>("agentSkills/list"),
  ]);
  return {
    sharing,
    people: view.members.filter((member) => member.userId !== userId),
    skills: givableSkills(catalog),
  };
}

/**
 * The apps and MCP servers the owner can declare, read apart from the sheet: the catalog only
 * names the apps and can be slow, and a failed one leaves the account names.
 */
export async function readShareableApps(
  botId: string,
  declared: BotSharing["connectors"],
): Promise<ShareableApp[]> {
  const [rows, catalog, servers] = await Promise.all([
    rpc<Connection[]>("connections/list"),
    rpc<ConnectionCatalogItem[]>("connections/catalog", {}).catch(() => []),
    Promise.all([
      rpc<McpServer[]>("mcp/servers/list"),
      rpc<BotMcpServer[]>("mcp/assignments/list", { botId }),
    ]).catch((): [McpServer[], BotMcpServer[]] => [[], []]),
  ]);
  const [all, assignments] = servers;
  const given = new Set(assignments.map((assignment) => assignment.serverId));
  return shareableApps(rows, catalog, { all, given }, declared, t("Deleted"));
}

/**
 * Saves who the bot is shared with or what it declares, then reads the skills again, since sharing
 * changes which count for the bot; a failed reread keeps the skills shown (`null`).
 */
export async function saveSharing(
  botId: string,
  next: Omit<BotSharing, "connectors"> & Partial<Pick<BotSharing, "connectors">>,
): Promise<{ sharing: BotSharing; skills: AgentSkillCatalogEntry[] | null }> {
  const sharing = await rpc<BotSharing>("bots/share", { botId, ...next });
  const skills = await rpc<AgentSkillCatalogEntry[]>("agentSkills/list").then(
    givableSkills,
    () => null,
  );
  return { sharing, skills };
}
