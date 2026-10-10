import type { Bot } from "@rakazo/contracts";
import { createAnswerOrder } from "@rakazo/core";

/**
 * The bots the bot page shows, outside React so the page and the screens it
 * pushes (an editor, the model picker) read one copy. Every call that reaches
 * the server goes through `write` or `read`, which decide what a late answer
 * may still change: a write's answer lands by the shared answer order, field
 * by field for the fields it `sent`; a read lands only if no write answered
 * while it was in flight, since the server may have read the row before that write.
 */
export interface BotRecords {
  bot(botId: string): Bot | undefined;
  subscribe(listener: () => void): () => void;
  /** `sent` names the fields the write changes, so a late answer still lands them. */
  write(botId: string, run: () => Promise<Bot>, sent?: readonly string[]): Promise<Bot>;
  /** Reads the bot; a failed read throws and leaves what was known. */
  read(botId: string, run: () => Promise<Bot>): Promise<void>;
  reset(): void;
}

export function createBotRecords(): BotRecords {
  const bots = new Map<string, Bot>();
  const listeners = new Set<() => void>();
  const order = createAnswerOrder();
  let generation = 0;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    bot: (botId) => bots.get(botId),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async write(botId, run, sent = []) {
      const request = order.next();
      const started = generation;
      const bot = await run();
      const merge = started === generation ? order.write(botId, request, sent, bot) : null;
      if (merge) {
        bots.set(botId, merge(bots.get(botId)));
        notify();
      }
      return bot;
    },
    async read(botId, run) {
      const request = order.next();
      const started = generation;
      const bot = await run();
      if (started === generation && order.read(botId, request)) {
        bots.set(botId, bot);
        notify();
      }
    },
    reset() {
      generation += 1;
      bots.clear();
      order.reset();
      notify();
    },
  };
}
