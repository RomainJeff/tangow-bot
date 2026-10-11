import type { SessionEntry, SessionId, ThreadItem } from "@rakazo/contracts";

export type ChildSession = { kind: "routine" | "subagent"; name: string };

export function childSessionsOf(entries: readonly SessionEntry[]): Map<string, ChildSession> {
  const children = new Map<string, ChildSession>();
  for (const entry of entries) {
    if (entry.type === "routine.started" || entry.type === "subagent") {
      const kind = entry.type === "subagent" ? "subagent" : "routine";
      children.set(entry.payload.sessionId, { kind, name: entry.payload.name });
    }
  }
  return children;
}

export function originSessionIdOf(entry: SessionEntry): SessionId | undefined {
  return "originSessionId" in entry.payload ? entry.payload.originSessionId : undefined;
}

type ItemOrigin = NonNullable<Extract<ThreadItem, { origin?: unknown }>["origin"]>;
export type SessionOrigin = Exclude<ItemOrigin, { entryId: unknown }>;

/** The routine or helper session an item rose from; a botMessage's entry origin is not one. */
export function sessionOriginOf(item: ThreadItem): SessionOrigin | null {
  const origin = "origin" in item ? item.origin : undefined;
  return origin && !("entryId" in origin) ? origin : null;
}
