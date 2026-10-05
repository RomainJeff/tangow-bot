import { describe, expect, it } from "vitest";
import { createReadLimiter, createSemaphore } from "./limits.js";

describe("read limiter", () => {
  it("caps the total and each host, and release is idempotent", () => {
    const limiter = createReadLimiter({ total: 3, perHost: 2 });
    const a1 = limiter.tryAcquire("a.test");
    const a2 = limiter.tryAcquire("A.test");
    expect(a1 && a2).toBeTruthy();
    expect(limiter.tryAcquire("a.test")).toBeUndefined();
    const b1 = limiter.tryAcquire("b.test");
    expect(b1).toBeTypeOf("function");
    expect(limiter.tryAcquire("c.test")).toBeUndefined();
    a1?.();
    a1?.();
    expect(limiter.tryAcquire("c.test")).toBeTypeOf("function");
    expect(limiter.tryAcquire("c.test")).toBeUndefined();
  });

  it("defaults to 8 reads and 2 per host", () => {
    const limiter = createReadLimiter();
    const held = Array.from({ length: 4 }, (_, host) => [
      limiter.tryAcquire(`h${host}.test`),
      limiter.tryAcquire(`h${host}.test`),
    ]).flat();
    expect(held.every(Boolean)).toBe(true);
    expect(limiter.tryAcquire("h9.test")).toBeUndefined();
    expect(limiter.tryAcquire("h0.test")).toBeUndefined();
  });
});

describe("semaphore", () => {
  it("never runs more than max at once and serves waiters in order", async () => {
    const semaphore = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (id: number) =>
      semaphore.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      });
    await Promise.all([1, 2, 3, 4, 5, 6].map(task));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("frees the slot when the work throws", async () => {
    const semaphore = createSemaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(semaphore.run(async () => "next")).resolves.toBe("next");
  });
});
