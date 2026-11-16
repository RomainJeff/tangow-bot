import type { EncryptedSecretStore } from "@tangow/adapters";
import { buildMcpCredentialBlob } from "@tangow/adapters";
import { deriveMcpSlug } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";

// Remove after existing deployments have converted their legacy MCP installs.
export async function moveMcpSources(
  prisma: PrismaClient,
  secrets: EncryptedSecretStore,
  warn: (message: string) => void,
) {
  const installs = await prisma.capabilityInstall.findMany({ where: { kind: "mcp" } });
  for (const install of installs) {
    await prisma.$transaction(async (tx) => {
      const owner = { spaceId: install.spaceId, userId: install.userId };
      const config = install.config as {
        auth?: { type: string; name?: string };
        headers?: Record<string, string>;
      };
      let token: string | undefined;
      if (install.secretId) {
        const row = await tx.secret.findFirst({ where: { id: install.secretId, ...owner } });
        try {
          if (!row) throw new Error("Missing secret");
          token = secrets.load(row.ciphertext, row.id);
        } catch {
          warn(`Could not decrypt legacy MCP source ${install.id}; leaving it unchanged`);
          return;
        }
      }
      let server = await tx.mcpServer.findFirst({
        where: { ...owner, endpoint: install.source },
      });
      if (!server) {
        const headers = { ...config.headers };
        if (config.auth?.type === "header" && config.auth.name && token) {
          headers[config.auth.name] = token;
        }
        const payload = buildMcpCredentialBlob({
          secret: config.auth?.type === "bearer" ? token : undefined,
          headers,
        });
        const stored = payload
          ? await secrets.put(payload, {
              ...owner,
              operationId: "mcp.move",
              traceId: "mcp.move",
              signal: new AbortController().signal,
            })
          : null;
        if (stored) {
          await tx.secret.create({ data: { ...owner, ...stored, kind: "mcp" } });
        }
        const base = deriveMcpSlug(install.name);
        const slugs = new Set(
          (await tx.mcpServer.findMany({ where: owner, select: { slug: true } })).map(
            (row) => row.slug,
          ),
        );
        let slug = base;
        for (let suffix = 2; slugs.has(slug); suffix++) {
          const tail = `-${suffix}`;
          slug = `${base.slice(0, 64 - tail.length)}${tail}`;
        }
        server = await tx.mcpServer.create({
          data: {
            ...owner,
            name: install.name,
            slug,
            endpoint: install.source,
            transport: "streamable_http",
            headers: Object.fromEntries(Object.keys(headers).map((key) => [key, true])),
            secretId: stored?.id,
          },
        });
      }
      const bots = await tx.bot.findMany({ where: { ...owner, archivedAt: null } });
      await tx.botMcpServer.createMany({
        data: bots.map((bot) => ({
          ...owner,
          botId: bot.id,
          serverId: server.id,
          allowAllTools: true,
        })),
        skipDuplicates: true,
      });
      await tx.capabilityInstall.delete({ where: { id: install.id } });
      if (install.secretId) await tx.secret.delete({ where: { id: install.secretId } });
    });
  }
}
