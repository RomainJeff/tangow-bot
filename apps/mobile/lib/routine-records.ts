import type { Routine } from "@rakazo/contracts";
import { createAnswerOrder } from "@rakazo/core";

/**
 * Each bot's routines, outside React so the Routines tab and a routine's screen read one copy.
 * Answers land by the shared answer order, per routine as on the web: a write's answer sets the
 * fields it `sent` unless a newer write of them answered, and a list read keeps what a write
 * answered while the read was in flight, a routine created then included and a removed one gone.
 */
export interface RoutineRecords {
  routines(botId: string): Routine[] | undefined;
  subscribe(listener: () => void): () => void;
  /** Reads the bot's routines; a failed read throws and leaves what was known. */
  read(botId: string, run: () => Promise<Routine[]>): Promise<void>;
  write(
    botId: string,
    routineId: string,
    run: () => Promise<Routine>,
    sent: readonly string[],
  ): Promise<Routine>;
  create(botId: string, run: () => Promise<Routine>): Promise<Routine>;
  remove(botId: string, routineId: string, run: () => Promise<unknown>): Promise<void>;
  reset(): void;
}

export function createRoutineRecords(): RoutineRecords {
  const lists = new Map<string, Routine[]>();
  const listeners = new Set<() => void>();
  const order = createAnswerOrder();
  let generation = 0;
  const keyOf = (routineId: string) => `routine:${routineId}`;

  const change = (botId: string, update: (list: Routine[]) => Routine[]) => {
    const list = lists.get(botId);
    if (!list) return;
    lists.set(botId, update(list));
    for (const listener of listeners) listener();
  };

  return {
    routines: (botId) => lists.get(botId),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async read(botId, run) {
      const request = order.next();
      const started = generation;
      const read = await run();
      if (started !== generation || !order.read(`routines:${botId}`, request)) return;
      if (!lists.has(botId)) lists.set(botId, []);
      const fresh = (id: string) => order.read(keyOf(id), request);
      const ids = new Set(read.map((item) => item.id));
      change(botId, (held) => [
        ...read.flatMap((item) =>
          fresh(item.id) ? [item] : held.filter((kept) => kept.id === item.id),
        ),
        ...held.filter((item) => !ids.has(item.id) && !fresh(item.id)),
      ]);
    },
    async write(botId, routineId, run, sent) {
      const request = order.next();
      const started = generation;
      const routine = await run();
      const merge =
        started === generation ? order.write(keyOf(routineId), request, sent, routine) : null;
      if (merge)
        change(botId, (list) => list.map((item) => (item.id === routineId ? merge(item) : item)));
      return routine;
    },
    async create(botId, run) {
      const request = order.next();
      const started = generation;
      const routine = await run();
      if (started !== generation) return routine;
      order.write(keyOf(routine.id), request, [], routine);
      change(botId, (list) => [...list.filter((item) => item.id !== routine.id), routine]);
      return routine;
    },
    async remove(botId, routineId, run) {
      const started = generation;
      await run();
      if (started !== generation) return;
      order.close(keyOf(routineId));
      change(botId, (list) => list.filter((item) => item.id !== routineId));
    },
    reset() {
      generation += 1;
      lists.clear();
      order.reset();
      for (const listener of listeners) listener();
    },
  };
}
