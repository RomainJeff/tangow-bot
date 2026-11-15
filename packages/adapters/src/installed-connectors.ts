import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@tangow/adapter-kit";
import type { PrismaClient } from "@tangow/db";
import { z } from "zod";
import { connectorError, connectorResult } from "./connector-errors.js";
import {
  assertNoSensitiveQuery,
  HeaderName,
  PublicHeadersSchema,
  requireCredential,
} from "./connector-http.js";
import {
  CATALOG_EXECUTE,
  catalogEntries,
  catalogGroupLabel,
  DIRECT_TOOL_LIMIT,
  disambiguateInstalledToolNames,
  executeLazyCatalogControl,
  isLazyCatalogControlRoute,
  lazyCatalogTools,
  resolveCatalogCall,
} from "./lazy-tool-catalog.js";
import {
  callRemoteMcpTool,
  listRemoteMcpTools,
  type RemoteTransportDependencies,
} from "./remote-mcp.js";
import type { EncryptedSecretStore } from "./secrets.js";

const McpAuthSchema = z
  .object({
    type: z.enum(["none", "bearer", "header"]).default("none"),
    name: HeaderName.optional(),
  })
  .default({ type: "none" });

const McpConfigSchema = z.object({
  preset: z.enum(["treg", "custom"]).default("custom"),
  auth: McpAuthSchema,
  headers: PublicHeadersSchema,
});

type InstalledRow = {
  id: string;
  kind: string;
  name: string;
  source: string;
  secretId: string | null;
  config: unknown;
};

export type RemoteConnectorDependencies = RemoteTransportDependencies;

export class InstalledConnectorProvider implements ConnectorProvider {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secrets: EncryptedSecretStore,
    private readonly remote: RemoteConnectorDependencies = {},
  ) {}

  describe() {
    return {
      id: "installed",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: true },
    };
  }

  async discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    const tools = await this.authorizedTools(context);
    if (tools.length <= DIRECT_TOOL_LIMIT) return tools;
    return lazyCatalogTools("installed", "installed", "API", catalogEntries(tools));
  }

  async resolveCall(
    call: ConnectorCall,
    context: AdapterContext,
  ): Promise<{ call: ConnectorCall; tool: ConnectorTool } | undefined> {
    // Wrappers have no resourceId; real tools always do.
    if (call.route?.resourceId || call.route?.toolName !== CATALOG_EXECUTE) return undefined;
    return resolveCatalogCall(call, catalogEntries(await this.authorizedTools(context)));
  }

  private async authorizedTools(context: AdapterContext): Promise<ConnectorTool[]> {
    // A member's run on a shared bot gets only the apps its owner declared, never an installed source.
    if (context.memberId) return [];
    const installs = await this.prisma.capabilityInstall.findMany({
      where: {
        spaceId: context.spaceId,
        userId: context.userId,
        kind: "mcp",
      },
      orderBy: { createdAt: "asc" },
    });
    const tools: ConnectorTool[] = [];
    for (let offset = 0; offset < installs.length; offset += 4) {
      const groups = await Promise.all(
        installs.slice(offset, offset + 4).map((install) => this.discoverInstall(install, context)),
      );
      tools.push(...groups.flat());
    }
    return disambiguateInstalledToolNames(tools);
  }

  private async discoverInstall(
    install: InstalledRow,
    context: AdapterContext,
  ): Promise<ConnectorTool[]> {
    const catalogGroup = catalogGroupLabel(install.name, install.kind, install.id);
    try {
      const config = McpConfigSchema.parse(install.config);
      const credential = await this.loadCredential(install, context);
      const remote = await listRemoteMcpTools({
        endpoint: install.source,
        headers: connectorHeaders(config, credential),
        signal: context.signal,
        fetch: this.remote.fetch,
        resolveHostname: this.remote.resolveHostname,
      });
      return remote.map((tool) => ({
        ...tool,
        route: {
          connectorId: "installed",
          resourceId: install.id,
          toolName: tool.name,
          catalogGroup,
        },
      }));
    } catch {
      // One unavailable user-installed source must not hide the other tools.
      return [];
    }
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (call.route?.connectorId === "installed" && isLazyCatalogControlRoute(call.route)) {
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
    const installId = call.route?.resourceId;
    if (!installId) {
      yield {
        type: "error",
        kind: "invalid_arguments",
        message: "Installed connector route is missing",
      };
      return;
    }
    const install = await this.prisma.capabilityInstall.findFirst({
      where: {
        id: installId,
        spaceId: context.spaceId,
        userId: context.userId,
        kind: "mcp",
      },
    });
    if (!install) {
      yield {
        type: "error",
        kind: "permission_denied",
        message: "Installed connector is unavailable",
      };
      return;
    }
    let credential: string | undefined;
    try {
      credential = await this.loadCredential(install, context);
      const config = McpConfigSchema.parse(install.config);
      const result = await callRemoteMcpTool(
        {
          endpoint: install.source,
          headers: connectorHeaders(config, credential),
          signal: context.signal,
          fetch: this.remote.fetch,
          resolveHostname: this.remote.resolveHostname,
        },
        call.route?.toolName ?? call.tool,
        call.args,
      );
      yield connectorResult(result, credential ? [credential] : []);
    } catch (error) {
      yield connectorError(error, credential ? [credential] : []);
    }
  }

  private async loadCredential(
    install: Pick<InstalledRow, "secretId">,
    context: AdapterContext,
  ): Promise<string | undefined> {
    if (!install.secretId) return undefined;
    const row = await this.prisma.secret.findFirst({
      where: {
        id: install.secretId,
        spaceId: context.spaceId,
        userId: context.userId,
      },
    });
    return row ? this.secrets.load(row.ciphertext, row.id) : undefined;
  }
}

export async function verifyMcpInstall(input: {
  source: string;
  config: unknown;
  credential?: string;
  signal?: AbortSignal;
  remote?: RemoteConnectorDependencies;
}): Promise<{ config: Record<string, unknown>; toolCount: number }> {
  assertNoSensitiveQuery(input.source);
  const config = McpConfigSchema.parse(input.config);
  requireCredential(config.auth, input.credential);
  const tools = await listRemoteMcpTools({
    endpoint: input.source,
    headers: connectorHeaders(config, input.credential),
    signal: input.signal,
    fetch: input.remote?.fetch,
    resolveHostname: input.remote?.resolveHostname,
  });
  if (tools.length === 0) throw new Error("MCP server returned no tools");
  return { config, toolCount: tools.length };
}

function connectorHeaders(
  config: z.infer<typeof McpConfigSchema>,
  credential?: string,
): Record<string, string> {
  const headers = { ...config.headers };
  if (!credential || config.auth.type === "none") return headers;
  const name = config.auth.type === "header" ? config.auth.name : "authorization";
  if (!name) throw new Error("Authentication header name is required");
  headers[name] = config.auth.type === "bearer" ? `Bearer ${credential}` : credential;
  return headers;
}
