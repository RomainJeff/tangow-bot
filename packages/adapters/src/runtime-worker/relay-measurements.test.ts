import type { PiAiModelCall } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { clearRelayPrefixes, measureRelayPrefix } from "./relay-measurements.js";

const call: PiAiModelCall = {
  context: {
    messages: [
      {
        role: "system",
        content: "私",
        toolsAdded: [{ name: "read", parameters: {} }],
        sections: { recall: "memo" },
      },
      { role: "user", content: "hello", timestamp: 1 },
    ],
  },
  options: {},
};

describe("relay prefix measurements", () => {
  it("measures identical requests and the exact byte where history diverges without exporting content", () => {
    const conversation = { threadId: "prefix", botId: "bot", attemptId: "attempt" };
    const first = measureRelayPrefix(conversation, call);
    const samePrompt = structuredClone(call);
    samePrompt.context.messages[1]!.timestamp = 99;
    const identical = measureRelayPrefix(conversation, samePrompt);
    const changed = structuredClone(call);
    changed.context.messages[1] = { role: "user", content: "help", timestamp: 99 };
    const history = measureRelayPrefix(conversation, changed);
    const encoded =
      '[{"role":"system","content":"私","sections":{"recall":"memo"},"toolsAdded":[{"name":"read","parameters":{}}]},{"role":"user","content":"hello"}]';
    expect(first).toEqual({
      prefixFormat: "pi-ai-transcript-v1",
      promptBytes: Buffer.byteLength(encoded),
      previousRequest: false,
      commonPrefixBytes: 0,
      firstDivergingSection: null,
    });
    expect(identical).toEqual({
      ...first,
      previousRequest: true,
      commonPrefixBytes: Buffer.byteLength(encoded),
    });
    expect(history).toEqual({
      ...first,
      previousRequest: true,
      promptBytes: Buffer.byteLength(encoded) - 1,
      commonPrefixBytes: Buffer.byteLength(encoded.slice(0, encoded.indexOf("hello") + 3)),
      firstDivergingSection: "history",
    });
  });

  it.each(["system", "tools", "recall", "image"] as const)(
    "identifies a changed %s section",
    (section) => {
      const conversation = { threadId: `section-${section}`, botId: "bot", attemptId: "attempt" };
      const before = structuredClone(call);
      const after = structuredClone(call);
      if (section === "system") after.context.messages[0]!.content = "Other";
      if (section === "tools")
        after.context.messages[0]!.toolsAdded = [{ name: "write", parameters: {} }];
      if (section === "recall") after.context.messages[0]!.sections = { recall: "other" };
      if (section === "image") {
        before.context.messages[1]!.content = [
          { type: "image", data: "AAA", mimeType: "image/png" },
        ];
        after.context.messages[1]!.content = [
          { type: "image", data: "BBB", mimeType: "image/png" },
        ];
      }
      measureRelayPrefix(conversation, before);
      expect(measureRelayPrefix(conversation, after)?.firstDivergingSection).toBe(section);
    },
  );

  it("recognizes the controller's recalled-memory history block", () => {
    const conversation = { threadId: "recalled", botId: "bot", attemptId: "attempt" };
    measureRelayPrefix(conversation, {
      context: {
        messages: [
          { role: "user", content: "Memory recalled.\n<recalled_memory>first</recalled_memory>" },
        ],
      },
      options: {},
    });
    const changed = measureRelayPrefix(conversation, {
      context: {
        messages: [
          { role: "user", content: "Memory recalled.\n<recalled_memory>second</recalled_memory>" },
        ],
      },
      options: {},
    });
    expect(changed?.firstDivergingSection).toBe("recall");
  });

  it("skips an oversized or malformed measurement without retaining a stale predecessor", () => {
    const conversation = { threadId: "oversized", botId: "bot", attemptId: "attempt" };
    measureRelayPrefix(conversation, call);
    const large: PiAiModelCall = {
      context: { messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }] },
      options: {},
    };
    expect(measureRelayPrefix(conversation, large)).toBeNull();
    expect(measureRelayPrefix(conversation, call)?.previousRequest).toBe(false);
    const malformed = structuredClone(call);
    malformed.context.messages[0]!.content = 1n;
    expect(measureRelayPrefix(conversation, malformed)).toBeNull();
  });

  it("isolates helper attempts and clears their prompts while preserving root continuity", () => {
    const root = { threadId: "lifecycle", botId: "bot", attemptId: "attempt" };
    const helper = { ...root, helper: "helper:1", attemptId: "a" };
    measureRelayPrefix(root, call);
    measureRelayPrefix(helper, call);
    expect(measureRelayPrefix({ ...helper, attemptId: "b" }, call)?.previousRequest).toBe(false);
    clearRelayPrefixes("a");
    expect(measureRelayPrefix(helper, call)?.previousRequest).toBe(false);
    expect(measureRelayPrefix(root, call)?.previousRequest).toBe(true);
  });

  it("separates threads, bots and helpers", () => {
    const conversation = { threadId: "isolation", botId: "bot", attemptId: "attempt" };
    measureRelayPrefix(conversation, call);
    for (const other of [
      { ...conversation, threadId: "other" },
      { ...conversation, botId: "other" },
      { ...conversation, helper: "helper:1" },
    ])
      expect(measureRelayPrefix(other, call)?.previousRequest).toBe(false);
  });
});
