import type { EncryptedSecretStore } from "@rakazo/adapters";
import type { Actor, DeclaredMcp, McpServerConfigInput, MessageBlock } from "@rakazo/contracts";
import {
  botConnectors,
  IsolationError,
  type Prisma,
  type PrismaClient,
  sharedWithFilter,
} from "@rakazo/db";
import { createMcpServer, mcpServerDto } from "./mcp-servers.js";

/** This deployment's stdio rule, as the MCP connector applies it when it runs a server. */
export type McpStdioRule = { mcpStdioEnabled?: boolean; mcpStdioAllowedCommands?: string[] };

function runnable(server: { transport: string; command: string | null }, stdio: McpStdioRule) {
  if (server.transport !== "stdio") return true;
  return (
    Boolean(stdio.mcpStdioEnabled) &&
    (stdio.mcpStdioAllowedCommands ?? []).includes(server.command?.trim() ?? "")
  );
}

type OwnerAssignment = Prisma.BotMcpServerGetPayload<{ include: { server: true } }>;

/**
 * The owner's MCP servers a bot shared with the actor declares, as the owner gave them to the bot.
 * A server deleted, taken off the bot, or that this deployment can't run is left out.
 */
async function declaredServers(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  stdio: McpStdioRule,
): Promise<{ bot: { id: string }; servers: OwnerAssignment[] }> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, ...sharedWithFilter(actor.userId, actor.spaceId) },
    select: { id: true, userId: true, connectors: true },
  });
  if (!bot) throw new IsolationError();
  const serverIds = botConnectors(bot.connectors).flatMap((need) =>
    need.kind === "mcp" ? [need.serverId] : [],
  );
  const assignments = serverIds.length
    ? await prisma.botMcpServer.findMany({
        where: { botId: bot.id, userId: bot.userId, serverId: { in: serverIds } },
        include: { server: true },
      })
    : [];
  return { bot, servers: assignments.filter((row) => runnable(row.server, stdio)) };
}

async function declaredServer(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string; serverId: string },
  stdio: McpStdioRule,
) {
  const { bot, servers } = await declaredServers(prisma, actor, input.botId, stdio);
  const assignment = servers.find((row) => row.serverId === input.serverId);
  if (!assignment) throw new IsolationError();
  return { bot, assignment };
}

/** The public half: the server row holds header and env names, never their values. */
function publicHalf({ server, allowAllTools, allowedTools }: OwnerAssignment): DeclaredMcp {
  const dto = mcpServerDto(server);
  return {
    serverId: server.id,
    slug: dto.slug,
    name: dto.name,
    description: dto.description,
    transport: dto.transport,
    endpoint: dto.endpoint,
    command: dto.command,
    args: dto.args,
    headerKeys: dto.headerKeys,
    envKeys: dto.envKeys,
    allowedTools: allowAllTools
      ? null
      : (allowedTools as unknown[]).filter((tool): tool is string => typeof tool === "string"),
  };
}

export async function getDeclaredMcp(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string; serverId: string },
  stdio: McpStdioRule,
): Promise<DeclaredMcp> {
  return publicHalf((await declaredServer(prisma, actor, input, stdio)).assignment);
}

/**
 * The actor's own copy of a declared server, with their own credentials under the declared names,
 * given to the shared bot for the actor only with the tools its owner allows there.
 */
export async function addDeclaredMcp(
  deps: { prisma: PrismaClient; secrets: EncryptedSecretStore },
  actor: Actor,
  input: {
    botId: string;
    serverId: string;
    headers: Record<string, string>;
    env: Record<string, string>;
    secret?: string;
  },
  stdio: McpStdioRule,
) {
  const { bot, assignment } = await declaredServer(deps.prisma, actor, input, stdio);
  const declared = publicHalf(assignment);
  const only = (values: Record<string, string>, names: string[]) =>
    Object.fromEntries(names.flatMap((name) => (values[name] ? [[name, values[name]]] : [])));
  const base = {
    slug: await freeSlug(deps.prisma, actor, declared.slug),
    name: declared.name,
    description: declared.description,
    enabled: true,
    secret: input.secret || undefined,
  };
  const config: McpServerConfigInput =
    declared.transport === "stdio"
      ? {
          ...base,
          transport: "stdio",
          command: declared.command ?? "",
          args: declared.args,
          env: only(input.env, declared.envKeys),
        }
      : {
          ...base,
          transport: declared.transport,
          endpoint: declared.endpoint ?? "",
          headers: only(input.headers, declared.headerKeys),
        };
  return createMcpServer(deps, actor, config, (tx, mine) =>
    tx.botMcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: bot.id,
        serverId: mine.id,
        declaredServerId: declared.serverId,
        allowAllTools: declared.allowedTools === null,
        allowedTools: declared.allowedTools ?? [],
      },
    }),
  );
}

/** A card for each declared server the actor has not added to the bot yet. */
export async function missingDeclaredMcpCards(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
  stdio: McpStdioRule,
): Promise<Extract<MessageBlock, { kind: "app_connect" }>[]> {
  const { servers } = await declaredServers(prisma, actor, botId, stdio);
  if (servers.length === 0) return [];
  const added = await prisma.botMcpServer.findMany({
    where: { botId, userId: actor.userId, declaredServerId: { not: null } },
    select: { declaredServerId: true },
  });
  const have = new Set(added.map((row) => row.declaredServerId));
  return servers
    .filter((row) => !have.has(row.serverId))
    .map(({ server }) => ({
      kind: "app_connect",
      connectorId: "mcp",
      provider: server.id,
      name: server.name,
      description: server.description || (server.endpoint ?? server.command ?? ""),
      logo: null,
      status: "pending",
    }));
}

/** The owner's slug, or the first free `slug-2`, `slug-3`… among the actor's own servers. */
async function freeSlug(prisma: PrismaClient, actor: Actor, slug: string) {
  const taken = new Set(
    (
      await prisma.mcpServer.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, slug: { startsWith: slug } },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  let candidate = slug;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${slug.slice(0, 60)}-${n}`;
  return candidate;
}
