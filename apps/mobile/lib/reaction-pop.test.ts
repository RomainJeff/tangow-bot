import { describe, expect, it } from "vitest";
import { emptyReactionPopTracker, foldReactionPops, reactionPopKey } from "./reaction-pop";

function reactions(map: Record<string, Record<string, number>>): Map<string, Map<string, number>> {
  return new Map(
    Object.entries(map).map(([messageId, counts]) => [messageId, new Map(Object.entries(counts))]),
  );
}

describe("foldReactionPops", () => {
  it("pops nothing on a seeded pass (thread open)", () => {
    const { popped } = foldReactionPops(emptyReactionPopTracker(), reactions({ m1: { "👍": 1 } }), {
      seed: true,
    });
    expect(popped.size).toBe(0);
  });

  it("pops a pill that appears after the seed", () => {
    const seeded = foldReactionPops(emptyReactionPopTracker(), reactions({}), { seed: true });
    const { popped } = foldReactionPops(seeded.tracker, reactions({ m1: { "👍": 1 } }));
    expect(popped.has(reactionPopKey("m1", "👍"))).toBe(true);
  });

  it("pops a pill whose count increases, regardless of who reacted", () => {
    const seeded = foldReactionPops(emptyReactionPopTracker(), reactions({ m1: { "👍": 1 } }), {
      seed: true,
    });
    const { popped } = foldReactionPops(seeded.tracker, reactions({ m1: { "👍": 2 } }));
    expect(popped.has(reactionPopKey("m1", "👍"))).toBe(true);
  });

  it("does not pop a pill whose count is unchanged", () => {
    const seeded = foldReactionPops(emptyReactionPopTracker(), reactions({ m1: { "👍": 2 } }), {
      seed: true,
    });
    const { popped } = foldReactionPops(seeded.tracker, reactions({ m1: { "👍": 2 } }));
    expect(popped.size).toBe(0);
  });

  it("does not pop a pill whose count drops (a reaction removed)", () => {
    const seeded = foldReactionPops(emptyReactionPopTracker(), reactions({ m1: { "👍": 2 } }), {
      seed: true,
    });
    const { popped } = foldReactionPops(seeded.tracker, reactions({ m1: { "👍": 1 } }));
    expect(popped.size).toBe(0);
  });

  it("keys pops per message and emoji so unrelated pills are unaffected", () => {
    const seeded = foldReactionPops(
      emptyReactionPopTracker(),
      reactions({ m1: { "👍": 1 }, m2: { "🎉": 1 } }),
      { seed: true },
    );
    const { popped } = foldReactionPops(
      seeded.tracker,
      reactions({ m1: { "👍": 2 }, m2: { "🎉": 1 } }),
    );
    expect(popped.has(reactionPopKey("m1", "👍"))).toBe(true);
    expect(popped.has(reactionPopKey("m2", "🎉"))).toBe(false);
  });
});
