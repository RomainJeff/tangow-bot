import type { ThreadItem } from "@rakazo/contracts";

export type RoutineItem = Extract<ThreadItem, { kind: "routine" }>;

export type RoutineRole =
  | { kind: "message"; text: string }
  | {
      kind: "failures";
      count: number;
      since: string;
      folded: readonly string[];
    };

export function routineRoles(items: readonly ThreadItem[]): {
  roles: ReadonlyMap<string, RoutineRole>;
  hidden: ReadonlySet<string>;
} {
  const roles = new Map<string, RoutineRole>();
  const hidden = new Set<string>();
  let streak: RoutineItem[] = [];
  const endStreak = () => {
    const newest = streak.pop();
    if (newest) {
      const folded = streak.map((failure) => failure.id);
      for (const id of folded) hidden.add(id);
      roles.set(newest.id, {
        kind: "failures",
        count: folded.length + 1,
        since: streak[0]?.ts ?? newest.ts,
        folded,
      });
    }
    streak = [];
  };
  for (const item of items) {
    if (item.kind !== "routine") {
      endStreak();
      continue;
    }
    const { finished } = item;
    const text = finished?.status === "completed" ? finished.result.trim() : "";
    if (text) {
      endStreak();
      roles.set(item.id, { kind: "message", text });
    } else if (finished?.status !== "failed") {
      hidden.add(item.id);
    } else {
      const newest = streak.at(-1);
      if (newest && (newest.botId !== item.botId || newest.routineId !== item.routineId)) {
        endStreak();
      }
      streak.push(item);
    }
  }
  endStreak();
  return { roles, hidden };
}
