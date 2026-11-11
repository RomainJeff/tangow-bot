import type { ThreadEntry, ThreadItem } from "@tangow/contracts";
import { projectThreadItems } from "@tangow/core";
import type { PrismaClient } from "@tangow/db";

export { DestinationEmulator, McpEmulator } from "@tangow/adapters";

export function sessionCookieHeader(response: Response) {
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length) return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
  return response.headers.get("set-cookie")?.split(",")[0]?.split(";")[0] ?? "";
}

/** A thread's messages as the screens show them, in order. */
export function threadMessages(snapshot: { entries: ThreadEntry[] }) {
  return projectThreadItems(snapshot.entries).filter(
    (item): item is Extract<ThreadItem, { kind: "message" }> => item.kind === "message",
  );
}

/**
 * The newest card a run showed the person, by the entry an answer names: its question, its
 * choice, or its approval request, with the card as the person sees it.
 */
export async function latestCard(prisma: Pick<PrismaClient, "sessionEntry">, runId: string) {
  const entry = await prisma.sessionEntry.findFirstOrThrow({
    where: { runId, type: { in: ["assistant.ask", "assistant.choice", "effect.requested"] } },
    orderBy: { seq: "desc" },
  });
  const { block, card } = entry.payload as { block?: object; card?: object };
  return { id: entry.id, block: card ?? block };
}
export * from "./local-worker-provider.js";
