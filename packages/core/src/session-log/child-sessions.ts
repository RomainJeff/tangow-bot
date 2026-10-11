import type { SessionEntry, SessionId } from "@rakazo/contracts";

export type ChildSession = { kind: "routine" | "subagent"; name: string };

/** The child sessions the entries name, by session id: a routine's start or a helper's entry. */
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

/** The child session an entry rose from, if it rose. */
export function originSessionIdOf(entry: SessionEntry): SessionId | undefined {
  return "originSessionId" in entry.payload ? entry.payload.originSessionId : undefined;
}
