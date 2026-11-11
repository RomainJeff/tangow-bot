import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@tangow/adapter-kit";
import { isLocalMcpHost } from "@tangow/contracts";
import type { McpServer, PrismaClient } from "@tangow/db";
import { botConnectors } from "@tangow/db";
import { getLogger } from "@tangow/logging";
import { connectorError, connectorResult } from "./connector-errors.js";
import { sanitizeConnectorError } from "./connector-safety.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  DIRECT_TOOL_LIMIT,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import type { McpOAuthBroker, OAuthMaterial } from "./mcp-oauth.js";
import { McpReauthorizationRequiredError, oauthMaterialSecrets } from "./mcp-oauth.js";
import { McpSession } from "./mcp-transport.js";
import type { RemoteTransportDependencies } from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";

type SessionEntry = { session: McpSession; revision: number; material: OAuthMaterial };
type PendingSession = { revision: number; promise: Promise<McpSession> };

/** Runtime MCP connector. Authorization is re-checked against the bot assignment on every call. */
/**
 * Stale allowlist entries are filtered out below with no error. Discovery already has the
 * live tool list, so compare once and warn when string allowlist names are missing from the
 * server. Non-string JSON values are ignored for both the missing list and the ratio.
 */
export function allowlistDrift(
  allowedTools: unknown,
  offered: Array<{ name: string }>,
): { missing: string[]; offered: number; stringAllowedCount: number } {
  const names = new Set(offered.map((tool) => tool.name));
  const allowed = Array.isArray(allowedTools) ? allowedTools : [];
  const stringAllowed = allowed.filter((name): name is string => typeof name === "string");
  return {
    missing: stringAllowed.filter((name) => !names.has(name)),
    offered: names.size,
    stringAllowedCount: stringAllowed.length,
  };
}

function reportAllowlistDrift(
  assignment: { allowAllTools: boolean; allowedTools: unknown; server: { slug: string } },
  offered: Array<{ name: string }>,
  context: { spaceId: string; botId?: string },
): void {
  if (assignment.allowAllTools) return;
  const drift = allowlistDrift(assignment.allowedTools, offered);
  if (drift.missing.length === 0) return;
  getLogger().warn(
    `mcp allowlist drift on ${assignment.server.slug}: ${drift.missing.length}/${drift.stringAllowedCount} allowed tools are not offered (server offers ${drift.offered})`,
    {
      spaceId: context.spaceId,
      botId: context.botId,
      // Cap the list: the point is to name the drift, not to print an allowlist.
      missing: drift.missing.slice(0, 10),
    },
  );
}

export class McpConnector implements ConnectorProvider {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly connecting = new Map<string, PendingSession>();
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: EncryptedSecretStore,
    private readonly options: {
      stdioEnabled?: boolean;
      allowedCommands?: string[];
      network?: RemoteTransportDependencies;
    } = {},
    private readonly oauth?: McpOAuthBroker,
  ) {}

  describe() {
    return {
      id: "mcp",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    return lazyCatalogTools("mcp", "mcp", "MCP", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
  }

  /**
   * The run's person's own servers on the bot. On a bot shared with them, only their copies of
   * the servers its owner still declares and still gives the bot, enabled, each with the tools the
   * owner allows there now.
   */
  private async assignments(context: AdapterContext & { botId: string }, serverId?: string) {
    const where = {
      botId: context.botId,
      spaceId: context.spaceId,
      userId: context.userId,
      server: { enabled: true },
      ...(serverId ? { serverId } : {}),
    };
    if (!context.memberId) {
      return this.prisma.botMcpServer.findMany({ where, include: { server: true } });
    }
    const bot = await this.prisma.bot.findUnique({
      where: { id: context.botId },
      select: {
        userId: true,
        connectors: true,
        mcpServers: {
          where: { server: { enabled: true } },
          select: { userId: true, serverId: true, allowAllTools: true, allowedTools: true },
        },
      },
    });
    const declared = new Set(
      botConnectors(bot?.connectors ?? []).flatMap((need) =>
        need.kind === "mcp" ? [need.serverId] : [],
      ),
    );
    const live = new Map(
      (bot?.mcpServers ?? [])
        .filter((row) => row.userId === bot?.userId && declared.has(row.serverId))
        .map((row) => [row.serverId, row]),
    );
    const copies = await this.prisma.botMcpServer.findMany({
      where: { ...where, declaredServerId: { in: [...live.keys()] } },
      include: { server: true },
    });
    return copies.map((copy) => {
      const owner = live.get(copy.declaredServerId ?? "");
      return {
        ...copy,
        allowAllTools: !!owner?.allowAllTools,
        allowedTools: owner?.allowedTools ?? [],
      };
    });
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    if (!context.botId) return [];
    const assignments = await this.assignments({ ...context, botId: context.botId });
    const groups = await Promise.all(
      assignments.map(async (assignment): Promise<ConnectorTool[]> => {
        try {
          const session = await this.sessionFor(assignment.server, context);
          const listed = await session.listTools({ signal: context.signal });
          reportAllowlistDrift(assignment, listed.tools, context);
          return listed.tools
            .filter(
              (tool) =>
                assignment.allowAllTools ||
                (assignment.allowedTools as unknown[]).includes(tool.name),
            )
            .map((tool) => ({
              name: `mcp__${assignment.server.slug}__${tool.name}`,
              description: tool.description ?? tool.name,
              inputSchema: tool.inputSchema as Record<string, unknown>,
              readOnly: tool.annotations?.readOnlyHint,
              appName: assignment.server.name,
              route: {
                connectorId: "mcp",
                resourceId: assignment.serverId,
                resourceRevision: assignment.server.revision,
                toolName: tool.name,
                catalogGroup: assignment.server.slug,
              },
            }));
        } catch (error) {
          // A single unavailable server must not hide tools from other connectors.
          getLogger().error(
            `mcp discovery failed for server ${assignment.server.slug}:`,
            sanitizeConnectorError(error),
          );
          await this.evict(this.sessionKey(assignment.server, context));
          return [];
        }
      }),
    );
    return groups.flat();
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId !== "mcp") {
      yield {
        type: "error",
        kind: "invalid_arguments",
        message: `MCP route required for ${call.tool}`,
      };
      return;
    }
    if (isLazyCatalogControlRoute(call.route)) {
      try {
        yield* executeLazyCatalogControl(
          call,
          catalogEntries(await this.authorizedTools(context)),
          (resolved) => this.execute(resolved, context),
        );
      } catch (error) {
        yield connectorError(error);
      }
      return;
    }
    if (!call.route.resourceId) {
      yield {
        type: "error",
        kind: "invalid_arguments",
        message: `MCP route required for ${call.tool}`,
      };
      return;
    }
    if (!context.botId) {
      yield {
        type: "error",
        kind: "permission_denied",
        message: "MCP tools require a bot context",
      };
      return;
    }
    const [assignment] = await this.assignments(
      { ...context, botId: context.botId },
      call.route.resourceId,
    );
    if (
      !assignment ||
      (!assignment.allowAllTools &&
        !(assignment.allowedTools as unknown[]).includes(call.route.toolName))
    ) {
      yield {
        type: "error",
        kind: "permission_denied",
        message: "MCP tool is not assigned to this bot",
      };
      return;
    }
    // Capture material before callTool so a concurrent eviction/replace cannot
    // drop this call's OAuth secrets from model-visible redaction. Recompute via
    // oauthMaterialSecrets(material) so in-place token refresh stays covered.
    let material: OAuthMaterial | undefined;
    try {
      const session = await this.sessionFor(assignment.server, context);
      material = this.sessions.get(this.sessionKey(assignment.server, context))?.material;
      const result = await session.callTool(call.route.toolName, call.args, {
        signal: context.signal,
      });
      const secrets = material ? oauthMaterialSecrets(material) : [];
      yield connectorResult(result, secrets);
    } catch (error) {
      // A thrown call means the transport or auth broke; drop the session so the next call reconnects.
      const secrets = material ? oauthMaterialSecrets(material) : [];
      await this.evict(this.sessionKey(assignment.server, context));
      yield {
        ...connectorError(error, secrets),
        ...(error instanceof McpReauthorizationRequiredError
          ? { kind: "auth_required" as const }
          : {}),
      };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.connecting.values()].map(({ promise }) => promise));
    await Promise.all([...this.sessions.values()].map(({ session }) => session.close()));
    this.sessions.clear();
    this.connecting.clear();
  }

  private sessionKey(server: McpServer, context: AdapterContext): string {
    // Identity headers are applied once, at connect time, so a session is only
    // valid for the identity it connected as. The key has to carry that identity.
    return `${server.id} ${context.spaceId} ${context.userId}`;
  }

  private async evict(sessionKey: string): Promise<void> {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;
    this.sessions.delete(sessionKey);
    await entry.session.close();
  }

  private async sessionFor(server: McpServer, context: AdapterContext): Promise<McpSession> {
    const sessionKey = this.sessionKey(server, context);
    const existing = this.sessions.get(sessionKey);
    if (existing && existing.revision === server.revision) return existing.session;
    const pending = this.connecting.get(sessionKey);
    if (pending?.revision === server.revision) return pending.promise;
    if (pending) {
      await pending.promise.catch(() => undefined);
      await this.evict(sessionKey);
      return this.sessionFor(server, context);
    }
    if (existing) await this.evict(sessionKey);

    const promise = this.connectSession(server, context).then(({ session, material }) => {
      this.sessions.set(sessionKey, { session, revision: server.revision, material });
      return session;
    });
    this.connecting.set(sessionKey, { revision: server.revision, promise });
    try {
      return await promise;
    } finally {
      if (this.connecting.get(sessionKey)?.promise === promise) this.connecting.delete(sessionKey);
    }
  }

  private async connectSession(
    server: McpServer,
    context: AdapterContext,
  ): Promise<{ session: McpSession; material: OAuthMaterial }> {
    const session = new McpSession({ name: `rakazo-${server.slug}` });
    try {
      const secret = server.secretId
        ? await this.prisma.secret.findFirst({
            where: {
              id: server.secretId,
              spaceId: context.spaceId,
              userId: context.userId,
            },
          })
        : null;
      const material = secret
        ? (JSON.parse(this.secrets.load(secret.ciphertext, secret.id)) as OAuthMaterial)
        : {};
      const loaded = { material, ...(secret ? { secretId: secret.id } : {}) };
      const args = Array.isArray(server.args) ? server.args.map(String) : [];
      const env = { ...(material.env ?? {}) };
      if (server.transport === "stdio") {
        if (!this.options.stdioEnabled) throw new Error("MCP stdio is disabled");
        await session.connectStdio({
          command: String(server.command ?? ""),
          args,
          env,
          allowedCommands: this.options.allowedCommands ?? [],
          signal: context.signal,
        });
      } else {
        if (!server.endpoint) throw new Error("MCP endpoint is required");
        const endpoint = new URL(server.endpoint);
        const localHttp = endpoint.protocol === "http:" && isLocalMcpHost(endpoint.hostname);
        const authProvider =
          !localHttp && this.oauth
            ? await this.oauth.providerFor(server, context, loaded)
            : undefined;
        const staticToken = material.secret
          ? material.secret.startsWith("Bearer ")
            ? material.secret
            : `Bearer ${material.secret}`
          : undefined;
        const headers = {
          ...(material.headers ?? {}),
          ...(staticToken ? { Authorization: staticToken } : {}),
        };
        await session.connectRemote({
          url: server.endpoint,
          urlPolicy: { allowHttpLocalhost: localHttp, allowLocalHttpCredentials: localHttp },
          transport: server.transport === "sse" ? "sse" : "streamable-http",
          allowLegacySse: server.transport === "sse",
          headerPolicy: { headers },
          fallbackToSse: false,
          authProvider,
          network: this.options.network,
          signal: context.signal,
        });
      }
      return { session, material };
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }
}
