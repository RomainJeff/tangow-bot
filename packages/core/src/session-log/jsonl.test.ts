import { describe, expect, it } from "vitest";
import { longSessionJsonl } from "./fixtures/long-session.js";
import { bytesSource, FIXTURES, fixtureText } from "./fixtures/read-fixture.js";
import { decodeEntries, encodeEntries, readTailFromEnd } from "./jsonl.js";

describe("session log JSONL", () => {
  it.each(FIXTURES)("re-encodes the %s fixture byte for byte", (name) => {
    const text = fixtureText(name);
    expect(encodeEntries(decodeEntries(text))).toBe(text);
  });

  it("names the line and the field of an entry that fails validation", () => {
    const lines = fixtureText("linear").split("\n");
    lines[2] = lines[2]!.replace('"effort":"medium"', '"effort":"extreme"');
    expect(() => decodeEntries(lines.join("\n"))).toThrow(
      'Invalid session entry at line 3: payload.effort: Invalid option: expected one of "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"',
    );
  });

  it("reads a 10 000 line session backwards only as far as its last compaction", async () => {
    const text = longSessionJsonl({
      count: 10_000,
      compactionEvery: 500,
      rewind: { at: 9_800, to: 9_760 },
    });
    const bytes = new TextEncoder().encode(text);
    const served = { bytes: 0 };
    const chain = await readTailFromEnd(bytesSource(bytes, served), 4096);

    const onChain = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, index) => from + index);
    expect(chain.map((entry) => entry.seq)).toEqual([
      ...onChain(9_500, 9_760),
      ...onChain(9_800, 9_999),
    ]);
    expect(chain[0]?.type).toBe("compaction");
    const lastSixHundredLines = new TextEncoder().encode(
      text.split("\n").slice(-601).join("\n"),
    ).length;
    expect(served.bytes).toBeLessThan(lastSixHundredLines);
  });
});
