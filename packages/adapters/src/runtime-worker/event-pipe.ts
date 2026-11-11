import type { AgentRuntimeEvent } from "@tangow/adapter-kit";

type Pulled = { event: AgentRuntimeEvent; pulled: () => void };

/**
 * Events on their way to the executor. A producer resolves once the executor asks for the next
 * event, so an informative frame is acknowledged only when the executor took it: its loop is the
 * channel's backpressure.
 */
export function eventPipe() {
  const queued: Pulled[] = [];
  let current: Pulled | undefined;
  let wake: (() => void) | undefined;
  let ending: { error?: unknown } | undefined;
  const notify = () => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  return {
    push(event: AgentRuntimeEvent): Promise<void> {
      if (ending) return Promise.resolve();
      return new Promise((pulled) => {
        queued.push({ event, pulled });
        notify();
      });
    },
    /** Delivers what is queued, then ends; with an error, ends at once. */
    end(error?: unknown) {
      ending ??= error === undefined ? {} : { error };
      notify();
    },
    async next(): Promise<AgentRuntimeEvent | null> {
      current?.pulled();
      current = undefined;
      while (true) {
        if (ending && "error" in ending) throw ending.error;
        const item = queued.shift();
        if (item) {
          current = item;
          return item.event;
        }
        if (ending) return null;
        await new Promise<void>((resume) => {
          wake = resume;
        });
      }
    },
    /** Nothing will pull any more: release every waiting producer. */
    drain() {
      current?.pulled();
      for (const item of queued.splice(0)) item.pulled();
    },
  };
}
