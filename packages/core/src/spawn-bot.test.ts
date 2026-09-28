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
