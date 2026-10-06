/** Per-process caps for link-preview work. Each process (API, worker) has its own budget. */

export const MAX_CONCURRENT_READS = 8;
export const MAX_CONCURRENT_READS_PER_HOST = 2;
export const MAX_CONCURRENT_ENCODES = 2;

export interface ReadLimiter {
  /** Returns the release function, or undefined when a cap is reached. Release is idempotent. */
  tryAcquire(host: string): (() => void) | undefined;
}

export function createReadLimiter(
  limits: { total: number; perHost: number } = {
    total: MAX_CONCURRENT_READS,
    perHost: MAX_CONCURRENT_READS_PER_HOST,
  },
): ReadLimiter {
  let total = 0;
  const perHost = new Map<string, number>();
  return {
    tryAcquire(host) {
      const key = host.toLowerCase();
      const hostCount = perHost.get(key) ?? 0;
      if (total >= limits.total || hostCount >= limits.perHost) return undefined;
      total += 1;
      perHost.set(key, hostCount + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        total -= 1;
        const remaining = (perHost.get(key) ?? 1) - 1;
        if (remaining <= 0) perHost.delete(key);
        else perHost.set(key, remaining);
      };
    },
  };
}

export const processReadLimiter = createReadLimiter();

export interface Semaphore {
  /** The slot is freed when `work` settles, even if the caller stopped waiting for it. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async run(work) {
      // A freed slot is handed straight to the next waiter so a newcomer cannot jump in.
      if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
      else active += 1;
      try {
        return await work();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
      }
    },
  };
}

export const processEncodeSemaphore = createSemaphore(MAX_CONCURRENT_ENCODES);
