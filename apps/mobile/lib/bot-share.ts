import type {
  AgentSkillCatalogEntry,
  Bot,
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
import { readViewer } from "./bot-page";
import { t } from "./i18n";

/**
 * The bot, who it is shared with, who else is in its Space, and the owner's skills it can be
 * given. The bot is read here, not taken from the bot page's record, so any failed read, the
 * bot's included, ends in the sheet's Retry.
 */
export type ShareSheet = {
  bot: Pick<Bot, "name" | "spaceId">;
  sharing: BotSharing;
  people: SpaceMembers["members"];
  skills: AgentSkillCatalogEntry[];
};

export async function readShareSheet(botId: string): Promise<ShareSheet> {
  const [bot, me] = await Promise.all([rpc<Bot>("bots/get", { botId }), readViewer()]);
  const [sharing, view, catalog] = await Promise.all([
    rpc<BotSharing>("bots/sharing", { botId }),
    rpc<SpaceMembers>("spaces/members", { spaceId: bot.spaceId }),
    rpc<AgentSkillCatalogEntry[]>("agentSkills/list"),
  ]);
  return {
    bot: { name: bot.name, spaceId: bot.spaceId },
    sharing,
    people: view.members.filter((member) => member.userId !== me.userId),
    skills: givableSkills(catalog),
  };
}

/**
 * The apps and MCP servers the owner can declare, read apart from the sheet: the catalog only
 * names the apps and can be slow, and a failed one leaves the account names. A failed read of the
 * servers fails the list, since without them a declared server would read as deleted.
 */
export async function readShareableApps(
  botId: string,
  declared: BotSharing["connectors"],
): Promise<ShareableApp[]> {
  const [rows, catalog, all, assignments] = await Promise.all([
    rpc<Connection[]>("connections/list"),
    rpc<ConnectionCatalogItem[]>("connections/catalog", {}).catch(() => []),
    rpc<McpServer[]>("mcp/servers/list"),
    rpc<BotMcpServer[]>("mcp/assignments/list", { botId }),
  ]);
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
