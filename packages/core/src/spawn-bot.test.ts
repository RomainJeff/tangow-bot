import {
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH,
  SPAWN_BOT_PROMPT_MAX_LENGTH,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  botNameKey,
  normalizeSpawnBotArgs,
  spawnBotApprovalBlock,
  spawnBotEdits,
  spawnBotReadOnlyDetail,
  spawnBotToolArgs,
  validateSpawnBotArgs,
} from "./spawn-bot.js";

const ok = { name: "Veille", title: "Watches competitors", instructions: "Track them." };

describe("normalizeSpawnBotArgs", () => {
  it("trims, defaults absent fields to empty and requires strings", () => {
    expect(normalizeSpawnBotArgs({ name: "  Veille  ", prompt: null })).toEqual({
      name: "Veille",
      title: "",
      instructions: "",
      prompt: "",
      computerMode: "",
    });
    expect(normalizeSpawnBotArgs({ name: 4 })).toEqual({ error: "name must be a string." });
    expect(normalizeSpawnBotArgs({ name: "a", instructions: "x\r\ny" })).toMatchObject({
      instructions: "x\ny",
    });
  });

  it("builds canonical tool args with only the fields that carry a value", () => {
    const args = normalizeSpawnBotArgs({ name: " A ", computer_mode: "dedicated" });
    if ("error" in args) throw new Error(args.error);
    expect(spawnBotToolArgs(args)).toEqual({ name: "A", computer_mode: "dedicated" });
  });
});

describe("validateSpawnBotArgs (CA5)", () => {
  it("accepts plain values and the exact limits", () => {
    expect(validateSpawnBotArgs(ok, [])).toBeUndefined();
    expect(
      validateSpawnBotArgs(
        {
          name: "n".repeat(BOT_NAME_MAX_LENGTH),
          title: "t".repeat(BOT_TITLE_MAX_LENGTH),
          instructions: "i".repeat(SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH),
          prompt: "p".repeat(SPAWN_BOT_PROMPT_MAX_LENGTH),
          computer_mode: "dedicated",
        },
        [],
      ),
    ).toBeUndefined();
    expect(validateSpawnBotArgs({ ...ok, computer_mode: "" }, [])).toBeUndefined();
    expect(validateSpawnBotArgs({ ...ok, computer_mode: "team" }, [])).toBeUndefined();
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["a name over the limit", { name: "n".repeat(BOT_NAME_MAX_LENGTH + 1) }],
    ["a title over the limit", { title: "t".repeat(BOT_TITLE_MAX_LENGTH + 1) }],
    [
      "instructions over the limit",
      { instructions: "i".repeat(SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH + 1) },
    ],
    ["a prompt over the limit", { prompt: "p".repeat(SPAWN_BOT_PROMPT_MAX_LENGTH + 1) }],
    ["an unknown computer mode", { computer_mode: "shared" }],
    ["a non-string field", { title: 3 }],
  ])("refuses %s", (_label, patch) => {
    expect(validateSpawnBotArgs({ ...ok, ...patch }, [])).toEqual(expect.any(String));
  });

  it("refuses a name held by an active bot, ignoring case and edge spaces", () => {
    expect(validateSpawnBotArgs({ ...ok, name: "  VEILLE " }, ["Veille"])).toContain("already");
    expect(validateSpawnBotArgs({ ...ok, name: "Veille 2" }, ["Veille"])).toBeUndefined();
  });
});

describe("hidden characters and lines (CA21)", () => {
  it.each([
    ["zero-width space", "\u200B"],
    ["right-to-left override", "\u202E"],
    ["tag character", "\u{E0041}"],
    ["text variation selector", "\uFE0E"],
    ["extended variation selector", "\u{E0100}"],
    ["line separator", "\u2028"],
    ["control character", "\u0007"],
  ])("refuses a %s in a name and in instructions", (_label, char) => {
    expect(validateSpawnBotArgs({ ...ok, name: `Ve${char}ille` }, [])).toEqual(expect.any(String));
    expect(validateSpawnBotArgs({ ...ok, instructions: `Do${char}this` }, [])).toEqual(
      expect.any(String),
    );
    expect(validateSpawnBotArgs({ ...ok, prompt: `Do${char}this` }, [])).toEqual(
      expect.any(String),
    );
    expect(validateSpawnBotArgs({ ...ok, title: `Ti${char}tle` }, [])).toEqual(expect.any(String));
  });

  it.each([
    ["a composed emoji", "\u{1F9D1}\u200D\u{1F4BB}"],
    ["an emoji with a skin tone", "\u{1F469}\u{1F3FD}\u200D\u{1F680}"],
    ["an emoji presentation", "\u2764\uFE0F"],
    ["a keycap", "1\uFE0F\u20E3"],
    ["Persian with a ZWNJ", "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645"],
    ["Hebrew with a right-to-left mark", "\u05E9\u05DC\u05D5\u05DD\u200F"],
    ["a soft hyphen", "co\u00ADop"],
  ])("accepts %s", (_label, text) => {
    expect(validateSpawnBotArgs({ ...ok, name: `Bot ${text}` }, [])).toBeUndefined();
    expect(validateSpawnBotArgs({ ...ok, title: text }, [])).toBeUndefined();
    expect(validateSpawnBotArgs({ ...ok, instructions: text, prompt: text }, [])).toBeUndefined();
  });

  it.each([
    ["a joiner between letters", "a\u200Db"],
    ["two joiners in a row", "a\u200D\u200Db"],
    ["a joiner closing a word", "\u{1F9D1}\u200D"],
    ["a variation selector after a letter", "x\uFE0F"],
    ["a right-to-left override", "a\u202Eb"],
    ["a zero-width space", "a\u200Bb"],
    ["a tag character", "a\u{E0041}b"],
    ["a run of non-joiners", "a\u200C\u200Cb"],
    ["a run of directional marks", "a\u200F\u200Eb"],
    ["a Hangul filler", "a\u3164b"],
    ["a combining grapheme joiner", "a\u034Fb"],
    ["a Mongolian variation selector", "a\u180Bb"],
  ])("refuses %s", (_label, text) => {
    expect(validateSpawnBotArgs({ ...ok, name: text }, [])).toEqual(expect.any(String));
    expect(validateSpawnBotArgs({ ...ok, title: text }, [])).toEqual(expect.any(String));
    expect(validateSpawnBotArgs({ ...ok, instructions: text }, [])).toEqual(expect.any(String));
    expect(validateSpawnBotArgs({ ...ok, prompt: text }, [])).toEqual(expect.any(String));
  });

  it("names the field that holds hidden characters", () => {
    expect(validateSpawnBotArgs({ ...ok, title: "a\u200Bb" }, [])).toMatch(/^title must be/);
    expect(validateSpawnBotArgs({ ...ok, instructions: "a\u200Bb" }, [])).toMatch(
      /^instructions must not contain invisible/,
    );
    expect(validateSpawnBotArgs({ ...ok, prompt: "a\u200Bb" }, [])).toMatch(
      /^prompt must not contain invisible/,
    );
  });

  it("allows newlines and tabs in instructions and prompt only", () => {
    expect(
      validateSpawnBotArgs({ ...ok, instructions: "a\n\tb", prompt: "c\nd" }, []),
    ).toBeUndefined();
    expect(validateSpawnBotArgs({ ...ok, name: "a\nb" }, [])).toEqual(expect.any(String));
    expect(validateSpawnBotArgs({ ...ok, title: "a\nb" }, [])).toEqual(expect.any(String));
    expect(validateSpawnBotArgs({ ...ok, name: "a\tb" }, [])).toEqual(expect.any(String));
  });
});

describe("bot name comparison (CA22)", () => {
  it.each(["Alice\u200B", "ALICE ", "\uFF41\uFF4C\uFF49\uFF43\uFF45", " alice"])(
    "treats %j as Alice",
    (name) => {
      expect(botNameKey(name)).toBe(botNameKey("Alice"));
      expect(validateSpawnBotArgs({ ...ok, name }, ["Alice"])).toEqual(expect.any(String));
    },
  );

  it("collapses spacing inside a name", () => {
    expect(botNameKey("Alice  B")).toBe(botNameKey("Alice B"));
    expect(validateSpawnBotArgs({ ...ok, name: "Alice  B" }, ["Alice B"])).toContain("already");
  });

  it("keeps different names apart", () => {
    expect(botNameKey("Alice B")).not.toBe(botNameKey("Alice"));
  });
});

describe("names that could pass for a link (CA23)", () => {
  it.each([
    "[Fiable](https://e.example)",
    "![](https://e.example/p.png)",
    "a<b",
    "a>b",
    "Site www.e.example",
    "WWW.E.EXAMPLE",
    "see e.example://x",
  ])("refuses %j", (name) => {
    expect(validateSpawnBotArgs({ ...ok, name }, [])).toContain("web address");
  });

  it("accepts an ordinary name with parentheses and punctuation", () => {
    expect(validateSpawnBotArgs({ ...ok, name: "Veille (EU)" }, [])).toBeUndefined();
    expect(validateSpawnBotArgs({ ...ok, name: "R&D_bot *1*" }, [])).toBeUndefined();
  });
});

describe("spawnBotEdits (CA11)", () => {
  const proposed = { name: "Veille", instructions: "Track them." };

  it.each([
    ["the name only", { name: "Radar", instructions: "Track them." }, { name: "Radar" }],
    [
      "the instructions only",
      { name: "Veille", instructions: "Watch them." },
      { instructions: "Watch them." },
    ],
    [
      "both",
      { name: "Radar", instructions: "Watch them." },
      { name: "Radar", instructions: "Watch them." },
    ],
    ["the instructions cleared", { name: "Veille", instructions: "" }, { instructions: "" }],
    ["a trimmed name", { name: "  Radar ", instructions: "Track them." }, { name: "Radar" }],
  ])("returns only what changed: %s", (_label, next, expected) => {
    expect(spawnBotEdits(proposed, next)).toEqual(expected);
  });

  it.each([
    ["identical values", { name: "Veille", instructions: "Track them." }],
    ["edge spaces", { name: "  Veille ", instructions: " Track them.\n" }],
  ])("returns undefined for %s", (_label, next) => {
    expect(spawnBotEdits(proposed, next)).toBeUndefined();
  });

  it("treats CRLF as a newline", () => {
    expect(
      spawnBotEdits({ name: "A", instructions: "a\nb" }, { name: "A", instructions: "a\r\nb" }),
    ).toBeUndefined();
  });
});

describe("spawnBotApprovalBlock (CA2)", () => {
  it("builds the card text, detail and normalized fields from the stored request", () => {
    const card = spawnBotApprovalBlock("effect-1", {
      name: " Veille ",
      title: "Watches competitors",
      instructions: "Track them.\nWeekly.",
      prompt: "Start now.",
      computer_mode: "dedicated",
    });
    expect(card).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Create bot “Veille”?",
      detail: [
        "Title: Watches competitors",
        "Computer: Private",
        "Instructions:",
        "  Track them.",
        "  Weekly.",
        "First message:",
        "  Start now.",
      ].join("\n"),
      status: "pending",
      actions: [
        { id: "allow", label: "Create bot", outcome: "created" },
        { id: "deny", label: "Cancel", outcome: "cancelled" },
      ],
      spawnBot: {
        name: "Veille",
        title: "Watches competitors",
        instructions: "Track them.\nWeekly.",
        prompt: "Start now.",
        computerMode: "dedicated",
      },
    });
  });

  it("has no detail when only the name is set", () => {
    expect(spawnBotApprovalBlock("effect-1", { name: "Veille" }).detail).toBeUndefined();
  });
});

describe("hardening for edited values (CA20)", () => {
  it("refuses an isolated surrogate that jsonb would reject", () => {
    for (const patch of [
      { name: "Veille\uD800" },
      { instructions: "a\uDC00b" },
      { title: "\uD83D" },
      { prompt: "\uDE00 x" },
    ]) {
      expect(validateSpawnBotArgs({ ...ok, ...patch }, [])).toEqual(expect.any(String));
    }
    expect(validateSpawnBotArgs({ ...ok, name: "Veille \u{1F600}" }, [])).toBeUndefined();
  });

  it("checks lengths before scanning the characters", () => {
    const huge = "\u200B".repeat(10_000);
    expect(validateSpawnBotArgs({ ...ok, instructions: huge }, [])).toBe(
      `instructions must be at most ${SPAWN_BOT_INSTRUCTIONS_MAX_LENGTH} characters.`,
    );
    expect(validateSpawnBotArgs({ ...ok, prompt: huge }, [])).toBe(
      `prompt must be at most ${SPAWN_BOT_PROMPT_MAX_LENGTH} characters.`,
    );
    expect(validateSpawnBotArgs({ ...ok, title: huge }, [])).toBe(
      `title must be at most ${BOT_TITLE_MAX_LENGTH} characters.`,
    );
  });
});

describe("spawnBotReadOnlyDetail", () => {
  const bot = {
    title: "Veille concurrentielle",
    computerMode: "dedicated",
    prompt: "Start on the assigned work.\nThen report.",
  };

  it("lists title, private computer and first message, never the instructions", () => {
    expect(spawnBotReadOnlyDetail(bot)).toBe(
      "Title: Veille concurrentielle\nComputer: Private\nFirst message:\n  Start on the assigned work.\n  Then report.",
    );
  });

  it("omits what the bot does not have", () => {
    expect(spawnBotReadOnlyDetail({ title: "", computerMode: "team", prompt: "" })).toBeUndefined();
  });

  it("is the card detail without the instructions", () => {
    const card = spawnBotApprovalBlock("effect-1", {
      name: "Veille",
      instructions: "Track them.",
      title: bot.title,
      prompt: bot.prompt,
      computer_mode: "dedicated",
    });
    expect(card.detail).toBe(
      [
        "Title: Veille concurrentielle",
        "Computer: Private",
        "Instructions:",
        "  Track them.",
        "First message:",
        "  Start on the assigned work.",
        "  Then report.",
      ].join("\n"),
    );
    expect(card.detail?.replace("Instructions:\n  Track them.\n", "")).toBe(
      spawnBotReadOnlyDetail(bot),
    );
  });
});
