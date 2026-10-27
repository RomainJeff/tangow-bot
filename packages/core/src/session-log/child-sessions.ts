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

export type SessionOrigin = { sessionId: SessionId; name: string };

// An unnamed origin is the bot's own run session, a helper's, or a routine whose start is on an
// older page: no label.
export function sessionOriginOf(item: ThreadItem): SessionOrigin | null {
  const origin = "origin" in item ? item.origin : undefined;
  if (!origin || "entryId" in origin || !origin.name || item.kind === "botMessage") return null;
  return { sessionId: origin.sessionId, name: origin.name };
}

/** What a step shows: the name a `run_subagent` call gave its helper, else the tool's name. */
export function stepCallTitle(call: { name: string; input: string }): string {
  if (call.name !== "run_subagent") return call.name;
  try {
    const { name } = JSON.parse(call.input) as { name?: unknown };
    return typeof name === "string" && name.trim() ? name.trim() : call.name;
  } catch {
    return call.name;
  }
}
