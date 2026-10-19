import { createHash } from "node:crypto";
import type { MemoryCollectionKind } from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SHA-256 of a value's JSON with object keys sorted, so stored JSONB key order cannot change it. */
export function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    return item;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

/** The version of a message's blocks that memory evidence and capture requests pin. */
export function messageDigest(blocks: unknown): string {
  return fingerprint(blocks);
}

type Owner = { spaceId: string; userId: string };

/**
 * The session entries a memory may quote, in the owner's own threads: the person's messages and a
 * bot's text. Ids that are not one of those come back missing.
 */
export async function findSourceMessages(
  client: Pick<Prisma.TransactionClient, "sessionEntry">,
  ids: string[],
  owner: Owner & { botId?: string },
): Promise<Array<{ id: string; blocks: unknown; role: "user" | "assistant" }>> {
  if (ids.length === 0) return [];
  const rows = await client.sessionEntry.findMany({
    where: {
      id: { in: ids },
      type: { in: ["user.message", "assistant.text", "bot.text"] },
      session: {
        thread: {
          spaceId: owner.spaceId,
          userId: owner.userId,
          ...(owner.botId ? { botId: owner.botId } : {}),
        },
      },
    },
    select: { id: true, type: true, payload: true },
  });
  return rows.map((row) => ({
    id: row.id,
    blocks: (row.payload as { blocks?: unknown } | null)?.blocks,
    role: row.type === "user.message" ? "user" : "assistant",
  }));
}

/** Plain text of a message's text blocks, the span evidence offsets point into. */
export function messageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "kind" in block &&
      block.kind === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

export function titleFor(content: string, supplied?: string, fallback = "Untitled memory") {
  if (supplied?.trim()) return supplied.trim();
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean)
      ?.slice(0, 240) || fallback
  );
}

/**
 * Copy JSON-shaped metadata into fresh plain objects. `Object.fromEntries` defines own data
 * properties, so an imported `__proto__` key stays an inert key and never sets a prototype.
 */
export function normalizeJsonValue(value: unknown, depth = 0): unknown {
  if (depth > 50) throw new Error("Metadata exceeds the nesting limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item, depth + 1));
  const prototype = typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Metadata must contain JSON values");
  return Object.fromEntries(
    Object.entries(value as object)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, normalizeJsonValue(item, depth + 1)]),
  );
}

/**
 * Run an idempotent memory command inside its transaction: a replayed key returns the original
 * document, a new key is claimed before `run` and bound to the document it produced.
 */
export async function withMemoryCommand<T extends { id: string }>(
  tx: Prisma.TransactionClient,
  owner: Owner,
  command: { key?: string; fingerprint: string },
  replay: (documentId: string | null, sameFingerprint: boolean) => Promise<T>,
  run: () => Promise<T>,
): Promise<T> {
  const { key } = command;
  if (!key) return run();
  const where = { spaceId_userId_key: { spaceId: owner.spaceId, userId: owner.userId, key } };
  const existing = await tx.memoryCommand.findUnique({ where });
  if (existing) return replay(existing.documentId, existing.fingerprint === command.fingerprint);
  await tx.memoryCommand.create({
    data: { spaceId: owner.spaceId, userId: owner.userId, key, fingerprint: command.fingerprint },
  });
  const result = await run();
  await tx.memoryCommand.update({ where, data: { documentId: result.id } });
  return result;
}

/** Find or create the collection a memory belongs to; callers authorize the bot first. */
export async function memoryCollection(
  tx: Prisma.TransactionClient,
  owner: Owner,
  kind: MemoryCollectionKind,
  botId: string | null,
) {
  const data = {
    spaceId: owner.spaceId,
    kind,
    ownerUserId: kind === "space" ? null : owner.userId,
    botId: kind === "agent" ? botId : null,
  };
  return (
    (await tx.memoryCollection.findFirst({ where: data })) ?? tx.memoryCollection.create({ data })
  );
}
