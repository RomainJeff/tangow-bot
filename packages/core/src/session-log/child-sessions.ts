import type { SessionId, ThreadEntry, ThreadItem } from "@rakazo/contracts";

export type ChildSession = { kind: "routine" | "subagent"; name: string };

export function childSessionsOf(entries: readonly ThreadEntry[]): Map<string, ChildSession> {
  const children = new Map<string, ChildSession>();
  for (const entry of entries) {
    if (entry.type === "routine.started") {
      children.set(entry.payload.sessionId, { kind: "routine", name: entry.payload.name });
    } else if (entry.type === "subagent" && entry.payload.sessionId) {
      children.set(entry.payload.sessionId, { kind: "subagent", name: entry.payload.name });
    }
  }
  return children;
}

export function originSessionIdOf(entry: ThreadEntry): SessionId | undefined {
  return "originSessionId" in entry.payload ? entry.payload.originSessionId : undefined;
}

type ItemOrigin = NonNullable<Extract<ThreadItem, { origin?: unknown }>["origin"]>;
export type SessionOrigin = Exclude<ItemOrigin, { entryId: unknown }>;

export function sessionOriginOf(item: ThreadItem): SessionOrigin | null {
  const origin = "origin" in item ? item.origin : undefined;
  if (!origin || "entryId" in origin) return null;
  if (item.kind === "botMessage" && origin.kind === "routine") return null;
  return origin;
}
