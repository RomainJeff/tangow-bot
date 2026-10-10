import { describe, expect, it } from "vitest";
import { longSessionJsonl } from "./fixtures/long-session.js";
import { bytesSource, FIXTURES, fixtureText, linkEntries } from "./fixtures/read-fixture.js";
import { decodeEntries, encodeEntries, readTailFromEnd } from "./jsonl.js";

const encode = (text: string) => new TextEncoder().encode(text);
const tail = (text: string, chunkSize = 4096) =>
  readTailFromEnd(bytesSource(encode(text)), chunkSize);
const ids = (entries: readonly { id: string }[]) => entries.map((entry) => entry.id);
const note = (text: string) => ({ type: "system.note", payload: { text } });
const threeNotes = encodeEntries(linkEntries("n", [note("one"), note("two"), note("three")]));

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
    const lastSixHundredLines = new TextEncoder().encode(
      text.split("\n").slice(-601).join("\n"),
    ).length;
    expect(served.bytes).toBeLessThan(lastSixHundredLines);
  });

  it.each([
    ["keeps a final line whole but without its newline", threeNotes.slice(0, -1)],
    ["skips a final line cut mid-line", `${threeNotes}{"id":"n-3","sessionId":"ses_n","se`],
    ["skips a final line that is JSON but no entry", `${threeNotes}{"id":"n-3"}`],
  ])("%s in both readers", async (_, text) => {
    expect(ids(await tail(text))).toEqual(["n-0", "n-1", "n-2"]);
    expect(ids(decodeEntries(text))).toEqual(["n-0", "n-1", "n-2"]);
  });

  it("joins lines and multibyte characters that span chunks", async () => {
    const chain = await tail(fixtureText("linear"), 1);
    expect(ids(chain)).toEqual(
      Array.from({ length: 16 }, (_, seq) => `lin-${String(seq).padStart(2, "0")}`),
    );
    expect(chain.find((entry) => entry.type === "tool.result")?.payload).toEqual({
      callId: "call_weather",
      output: "18°C, sunny",
      isError: false,
      artifactIds: [],
    });
  });

  it("names the line whose parent is missing from the file", async () => {
    const lines = fixtureText("linear").split("\n");
    lines.splice(7, 1);
    await expect(tail(lines.join("\n"))).rejects.toThrow(
      "Invalid session entry at line 8 from the end: its parent lin-07 is missing from the file",
    );
  });

  it("stops at a clear entry", async () => {
    const text = encodeEntries(
      linkEntries("c", [
        note("before"),
        { parentId: null, type: "clear", payload: {} },
        note("after"),
      ]),
    );
    expect(ids(await tail(text))).toEqual(["c-1", "c-2"]);
  });

  it("reads an empty file as an empty chain", async () => {
    expect(await tail("")).toEqual([]);
  });

  it.each([0, 0.5])("rejects a chunk size of %s", async (chunkSize) => {
    await expect(tail(threeNotes, chunkSize)).rejects.toThrow(
      `chunkSize must be a positive integer, got ${chunkSize}`,
    );
  });
});
