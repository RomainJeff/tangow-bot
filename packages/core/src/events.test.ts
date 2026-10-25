import { describe, expect, it } from "vitest";
import {
  appendTextSegment,
  appendToolCallSegment,
  appendToolStep,
  containsSecret,
  endsSentence,
  humanizeToolName,
  isRunTerminalEvent,
  redactSecrets,
  reduceLiveMessageBlocks,
  runFailureError,
  sanitizeJsonValue,
  sanitizeUtf16ForJson,
  trackToolCallStreak,
  trackToolNameStreak,
} from "./events.js";

describe("redactSecrets", () => {
  it.each([
    ['api"key', 'raw=api"key; output={"value":"api\\"key"}'],
    ["line\nbreak", 'raw=line\nbreak; output={"value":"line\\nbreak"}'],
    ["path\\key", 'raw=path\\key; output={"value":"path\\\\key"}'],
  ])("masks raw and canonical JSON-escaped occurrences of %j", (secret, value) => {
    expect(redactSecrets(value, [secret])).toBe('raw=[redacted]; output={"value":"[redacted]"}');
  });

  it("masks overlapping known values completely without reordering the caller's secrets", () => {
    const secrets = ["token", 'token"tail'];
    expect(redactSecrets('token token"tail {"value":"token\\"tail"}', secrets)).toBe(
      '[redacted] [redacted] {"value":"[redacted]"}',
    );
    expect(secrets).toEqual(["token", 'token"tail']);
  });

  it("masks the union of overlapping values without exposing their suffixes", () => {
    expect(redactSecrets("abcde public", ["abc", "cde"])).toBe("[redacted] public");
  });

  it("preserves JSON escaping while masking nested string values and keys", () => {
    const input = JSON.stringify({
      text: JSON.stringify({ 'key"value': "line\nbreak", public: "K731" }),
    });
    expect(JSON.parse(JSON.parse(redactSecrets(input, ['key"value', "line\nbreak"])).text)).toEqual(
      { "[redacted]": "[redacted]", public: "K731" },
    );
  });

  it("still decodes JSON that opens after whitespace or as a string literal", () => {
    // `\u0074` spells the secret's first letter, so only a decoded parse can find it.
    expect(redactSecrets(' \n {"note":"\\u0074oken"}', ["token"])).toBe(
      ' \n {"note":"[redacted]"}',
    );
    expect(redactSecrets('"\\u0074oken"', ["token"])).toBe('"[redacted]"');
  });

  it("masks a field when nested JSON exceeds the shared work budget", () => {
    let input = "public";
    for (let i = 0; i < 20; i++) input = JSON.stringify(input);
    expect(redactSecrets(input, ["credential"])).toBe("[redacted]");
  });

  it("ignores empty secrets and preserves text when no secrets are known", () => {
    expect(redactSecrets("safe token token", ["", "token", ""])).toBe("safe [redacted] [redacted]");
    expect(redactSecrets("safe text", [""])).toBe("safe text");
    expect(redactSecrets("safe text", [])).toBe("safe text");
    expect(redactSecrets("", ["token"])).toBe("");
  });
});

describe("containsSecret", () => {
  it("detects secrets that JSON escaping changes", () => {
    expect(containsSecret({ 'api"key': { nested: 'api"key' } }, ['api"key'])).toBe(true);
    expect(containsSecret({ nested: ["line\nbreak"] }, ["line\nbreak"])).toBe(true);
  });

  it("does not confuse escaped text with the original control character", () => {
    expect(containsSecret({ value: "literal\\ntext" }, ["\n"])).toBe(false);
  });
});

describe("isRunTerminalEvent", () => {
  it("recognizes every terminal run outcome", () => {
    expect(isRunTerminalEvent({ type: "run.completed" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.failed" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.cancelled" })).toBe(true);
    expect(isRunTerminalEvent({ type: "run.started" })).toBe(false);
  });
});

describe("reduceLiveMessageBlocks", () => {
  it("preserves structured live activity markers", () => {
    expect(reduceLiveMessageBlocks([], { text: "Using browser", activity: true })).toEqual([
      { kind: "progress", text: "Using browser", activity: true },
    ]);
  });
});

describe("runFailureError", () => {
  it("returns the error only for run.failed with a real message", () => {
    expect(runFailureError({ type: "run.failed", payload: { error: "provider missing" } })).toBe(
      "provider missing",
    );
    expect(runFailureError({ type: "run.failed", payload: {} })).toBeNull();
    expect(runFailureError({ type: "run.failed", payload: { error: "   " } })).toBeNull();
    expect(runFailureError({ type: "run.failed", payload: { error: 42 } })).toBeNull();
    expect(runFailureError({ type: "run.failed" })).toBeNull();
    expect(runFailureError({ type: "run.completed", payload: { error: "nope" } })).toBeNull();
    expect(runFailureError({ type: "run.cancelled", payload: { error: "nope" } })).toBeNull();
  });

  it("trims surrounding space and clamps a runaway message", () => {
    expect(runFailureError({ type: "run.failed", payload: { error: "  spaced  " } })).toBe(
      "spaced",
    );
    const long = runFailureError({ type: "run.failed", payload: { error: "x".repeat(400) } });
    expect(long).toHaveLength(301);
    expect(long?.endsWith("…")).toBe(true);
  });
});

describe("humanizeToolName", () => {
  it("turns a Composio-style constant into a readable label", () => {
    expect(humanizeToolName("SLACK_FIND_CHANNELS")).toBe("Slack find channels");
  });

  it("turns a lowercase builtin tool name into a readable label", () => {
    expect(humanizeToolName("request_takeover")).toBe("Request takeover");
  });
});

describe("appendToolStep", () => {
  it("starts a new step for the first call", () => {
    expect(appendToolStep([], "SLACK_FIND_CHANNELS")).toEqual([
      { label: "Slack find channels", count: 1 },
    ]);
  });

  it("increments the count when the same tool fires again in a row", () => {
    const first = appendToolStep([], "SLACK_FIND_CHANNELS");
    expect(appendToolStep(first, "SLACK_FIND_CHANNELS")).toEqual([
      { label: "Slack find channels", count: 2 },
    ]);
  });

  it("appends a new step when a different tool fires", () => {
    const first = appendToolStep([], "SLACK_FIND_CHANNELS");
    expect(appendToolStep(first, "SLACK_FETCH_CONVERSATION_HISTORY")).toEqual([
      { label: "Slack find channels", count: 1 },
      { label: "Slack fetch conversation history", count: 1 },
    ]);
  });
});

describe("trackToolCallStreak", () => {
  it("starts a streak of 1 for the first call", () => {
    expect(
      trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", { cursor: "a" }),
    ).toEqual({ key: 'SLACK_FIND_CHANNELS:{"cursor":"a"}', count: 1 });
  });

  it("increments the count when the same tool and args repeat", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FIND_CHANNELS", { cursor: "a" })).toEqual({
      key: 'SLACK_FIND_CHANNELS:{"cursor":"a"}',
      count: 2,
    });
  });

  it("resets the streak when the same tool is called with different args", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FIND_CHANNELS", { cursor: "b" })).toEqual({
      key: 'SLACK_FIND_CHANNELS:{"cursor":"b"}',
      count: 1,
    });
  });

  it("resets the streak when a different tool is called", () => {
    const first = trackToolCallStreak({ key: undefined, count: 0 }, "SLACK_FIND_CHANNELS", {
      cursor: "a",
    });
    expect(trackToolCallStreak(first, "SLACK_FETCH_CONVERSATION_HISTORY", { cursor: "a" })).toEqual(
      { key: 'SLACK_FETCH_CONVERSATION_HISTORY:{"cursor":"a"}', count: 1 },
    );
  });
});

describe("trackToolNameStreak", () => {
  it("starts a streak of 1 for the first call", () => {
    expect(trackToolNameStreak({ name: undefined, count: 0 }, "shell")).toEqual({
      name: "shell",
      count: 1,
    });
  });

  it("increments the count when the same tool name repeats, even with different arguments", () => {
    const first = trackToolNameStreak({ name: undefined, count: 0 }, "shell");
    expect(trackToolNameStreak(first, "shell")).toEqual({ name: "shell", count: 2 });
  });

  it("resets the streak when a different tool is called", () => {
    const first = trackToolNameStreak({ name: undefined, count: 0 }, "shell");
    expect(trackToolNameStreak(first, "recall_memory")).toEqual({
      name: "recall_memory",
      count: 1,
    });
  });
});

describe("endsSentence", () => {
  it("is false mid-clause, with no terminal punctuation", () => {
    expect(endsSentence("Let me check what I have loca")).toBe(false);
  });

  it("is false when the text trails off on whitespace with no punctuation", () => {
    expect(endsSentence("Let me check Slack ")).toBe(false);
  });

  it("is true once the text ends on a sentence terminator", () => {
    expect(endsSentence("Let me check. ")).toBe(true);
    expect(endsSentence("Is that right?")).toBe(true);
    expect(endsSentence('She said "stop!"')).toBe(true);
  });

  it("is true for an empty or whitespace-only string — nothing to protect", () => {
    expect(endsSentence("")).toBe(true);
    expect(endsSentence("   ")).toBe(true);
  });
});

describe("appendTextSegment", () => {
  it("starts a new text segment when there are none", () => {
    expect(appendTextSegment([], "hello")).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("does nothing when the text is empty", () => {
    const segments = [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }];
    expect(appendTextSegment(segments, "")).toEqual(segments);
  });

  it("merges into the last segment when it is already text", () => {
    const segments = appendTextSegment([], "a");
    expect(appendTextSegment(segments, "b")).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("starts a new text segment after a steps segment", () => {
    const segments = [{ kind: "steps" as const, steps: [{ label: "Shell", count: 1 }] }];
    expect(appendTextSegment(segments, "done")).toEqual([
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
      { kind: "text", text: "done" },
    ]);
  });
});

describe("appendToolCallSegment", () => {
  it("starts a new steps segment when there are none", () => {
    expect(appendToolCallSegment([], "SLACK_FIND_CHANNELS")).toEqual([
      { kind: "steps", steps: [{ label: "Slack find channels", count: 1 }] },
    ]);
  });

  it("collapses into the last steps segment for the same tool", () => {
    const segments = appendToolCallSegment([], "SLACK_FIND_CHANNELS");
    expect(appendToolCallSegment(segments, "SLACK_FIND_CHANNELS")).toEqual([
      { kind: "steps", steps: [{ label: "Slack find channels", count: 2 }] },
    ]);
  });

  it("starts a new steps segment after a text segment", () => {
    const segments = [{ kind: "text" as const, text: "hi" }];
    expect(appendToolCallSegment(segments, "shell")).toEqual([
      { kind: "text", text: "hi" },
      { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
    ]);
  });

  it("adds a new step entry within the same steps segment for a different tool", () => {
    const segments = appendToolCallSegment([], "SLACK_FIND_CHANNELS");
    expect(appendToolCallSegment(segments, "shell")).toEqual([
      {
        kind: "steps",
        steps: [
          { label: "Slack find channels", count: 1 },
          { label: "Shell", count: 1 },
        ],
      },
    ]);
  });
});

describe("sanitizeUtf16ForJson", () => {
  it("keeps complete surrogate pairs and replaces unpaired surrogates", () => {
    expect(sanitizeUtf16ForJson("😀")).toBe("😀");
    expect(sanitizeUtf16ForJson("a\uD83D")).toBe("a\uFFFD");
    expect(sanitizeUtf16ForJson("\uDE00b")).toBe("\uFFFDb");
    expect(sanitizeJsonValue({ delta: "x\uD83D", nested: ["\uDE00"] })).toEqual({
      delta: "x\uFFFD",
      nested: ["\uFFFD"],
    });
  });

  it("sanitizes nested object keys and disambiguates collisions after replacement", () => {
    expect(
      sanitizeJsonValue({
        outer: {
          // biome-ignore lint/complexity/useLiteralKeys: keep computed keys so unpaired surrogates stay intentional fixtures
          ["meta\uD83D"]: "ok",
          // biome-ignore lint/complexity/useLiteralKeys: keep computed keys so unpaired surrogates stay intentional fixtures
          ["meta\uDE00"]: "also",
        },
      }),
    ).toEqual({
      outer: {
        "meta\uFFFD": "ok",
        "meta\uFFFD#2": "also",
      },
    });
  });
});
