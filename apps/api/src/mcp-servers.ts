import type { EncryptedSecretStore } from "@rakazo/adapters";
import { buildMcpCredentialBlob } from "@rakazo/adapters";
import type { Actor, McpServer, McpServerConfigInput } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";

export function mcpServerDto(
  row: {
    id: string;
    spaceId: string;
    slug: string;
    name: string;
    description: string;
    transport: string;
    endpoint: string | null;
    command: string | null;
    args: unknown;
    env: unknown;
    headers: unknown;
    secretId: string | null;
    enabled: boolean;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
  },
  oauthStatus: McpServer["oauthStatus"] = "none",
): McpServer {
  const args = Array.isArray(row.args)
    ? row.args.filter((item): item is string => typeof item === "string")
    : [];
  const envKeys =
    row.env && typeof row.env === "object" && !Array.isArray(row.env) ? Object.keys(row.env) : [];
  const headerKeys =
    row.headers && typeof row.headers === "object" && !Array.isArray(row.headers)
      ? Object.keys(row.headers)
      : [];
  return {
    id: row.id,
    spaceId: row.spaceId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport as McpServer["transport"],
    endpoint: row.endpoint,
    command: row.command,
    args,
    envKeys,
    headerKeys,
    hasSecret: row.secretId !== null,
    oauthStatus,
    enabled: row.enabled,
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Stores an MCP server for the actor: its credentials encrypted, the row with header and env names
 * only. `then` runs in the same transaction.
 */
export async function createMcpServer(
  deps: { prisma: PrismaClient; secrets: EncryptedSecretStore },
  actor: Actor,
  input: McpServerConfigInput,
  then?: (tx: Prisma.TransactionClient, server: { id: string }) => Promise<unknown>,
) {
  const secretPayload = buildMcpCredentialBlob(input);
  const stored = secretPayload
    ? await deps.secrets.put(secretPayload, {
        operationId: "mcp.create",
        traceId: "mcp.create",
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: "mcp",
        signal: new AbortController().signal,
      })
    : null;
  return deps.prisma.$transaction(async (tx) => {
    if (stored) {
      await tx.secret.create({
        data: {
          id: stored.id,
          userId: actor.userId,
          spaceId: actor.spaceId,
          kind: "mcp",
          ciphertext: stored.ciphertext,
        },
      });
    }
    const server = await tx.mcpServer.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        slug: input.slug,
        name: input.name,
        description: input.description,
        transport: input.transport,
        endpoint: "endpoint" in input ? input.endpoint : null,
        command: "command" in input ? input.command : null,
        args: ("args" in input ? input.args : []) as Prisma.InputJsonValue,
        env: ("env" in input
          ? Object.fromEntries(Object.keys(input.env).map((key) => [key, true]))
          : {}) as Prisma.InputJsonValue,
        headers: ("headers" in input
          ? Object.fromEntries(Object.keys(input.headers).map((key) => [key, true]))
          : {}) as Prisma.InputJsonValue,
        secretId: stored?.id,
        enabled: input.enabled,
      },
    });
    await then?.(tx, server);
    return server;
  });
}
