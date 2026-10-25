import { describe, expect, it } from "vitest";
import {
  describeToolActivity,
  stripFakeToolCalls,
  stripModelControlTokens,
} from "./agent-text-policy.js";

describe("stripModelControlTokens", () => {
  it("removes a whole-message end token (the reported <|eos|> leak)", () => {
    expect(stripModelControlTokens("<|eos|>")).toBe("");
  });

  it("strips common special/role tokens across models", () => {
    for (const token of [
      "<|eos|>",
      "<|eot_id|>",
      "<|endoftext|>",
      "<|im_end|>",
      "<|im_start|>",
      "<|end_of_turn|>",
      "<|assistant|>",
      "<|user|>",
    ]) {
      expect(stripModelControlTokens(`hello${token}`)).toBe("hello");
    }
  });

  it("strips a token that appears inline, keeping the surrounding text", () => {
    expect(stripModelControlTokens("Voilà le point.<|eos|>")).toBe("Voilà le point.");
    expect(stripModelControlTokens("a<|im_end|>b")).toBe("ab");
  });

  it("leaves ordinary prose untouched, including harmless pipes and angle brackets", () => {
    for (const text of [
      "Nothing to strip here.",
      "a | b > c and 1 < 2",
      "Use the <div> tag, or a|b in a table.",
      "",
    ]) {
      expect(stripModelControlTokens(text)).toBe(text);
    }
  });

  it("does not match a bracketed phrase with spaces (only tight control-token shapes)", () => {
    expect(stripModelControlTokens("<| not a token |>")).toBe("<| not a token |>");
  });
});

describe("describeToolActivity", () => {
  it("names the kind of work for builtin tools", () => {
    expect(describeToolActivity("read_file")).toBe("Reading a file");
    expect(describeToolActivity("shell")).toBe("Working the terminal");
    expect(describeToolActivity("web_search")).toBe("Searching the web");
    expect(describeToolActivity("browser_run")).toBe("Clicking through a site");
    expect(describeToolActivity("computer_act")).toBe("Taking the mouse");
    expect(describeToolActivity("run_subagent")).toBe("Briefing a helper");
    expect(describeToolActivity("skill_create")).toBe("Learning a new trick");
  });

  it.each([
    ["mcp__rakazo__web_search", "Searching the web"],
    ["mcp__rakazo__browser_snapshot", "Reading the page"],
    ["mcp__rakazo__computer_act", "Taking the mouse"],
    ["mcp__rakazo__run_subagent", "Briefing a helper"],
    ["mcp__rakazo__remember", "Tucking it into memory"],
    ["mcp__rakazo__mcp__notion__read_file", "Seeing to it"],
    ["mcp__other__read_file", "Seeing to it"],
  ])("describes %s without exposing its MCP name", (name, label) => {
    expect(describeToolActivity(name)).toBe(label);
  });

  it("names the connected app a tool belongs to", () => {
    expect(describeToolActivity("mcp__notion-work__search_pages", "Notion")).toBe(
      "Stepping into Notion",
    );
  });

  it.each([
    ["read", "Reading a file"],
    ["ls", "Skimming a folder"],
    ["write", "Saving a file"],
    ["edit", "Editing a file"],
    ["bash", "Working the terminal"],
  ])("labels the worker's native %s tool like its in-process counterpart", (name, label) => {
    expect(describeToolActivity(name)).toBe(label);
  });

  it("never derives a label from an unknown tool's name", () => {
    expect(describeToolActivity("mcp__notion-work__search_pages")).toBe("Seeing to it");
    expect(describeToolActivity("destination_write")).toBe("Seeing to it");
    expect(describeToolActivity("toString")).toBe("Seeing to it");
  });
});

describe("stripFakeToolCalls", () => {
  it("cuts balanced trace spans, including brackets inside JSON strings", () => {
    const reply =
      'Voilà.\n[tool web_search({ "query": "a ] b" }) → { "results": [ { "t": "x" } ] }] [tool message_user({ "message": "Liens :\\n• (a)" })]\nBonne journée';
    expect(stripFakeToolCalls(reply)).toBe("Voilà.\n \nBonne journée");
  });

  it("drops an unclosed span to the end and keeps text before it", () => {
    expect(stripFakeToolCalls('ok [tool message_user({ "message": "trunc')).toBe("ok");
  });

  it("stands in for a reply that was only fake calls", () => {
    expect(stripFakeToolCalls('[tool message_user({ "message": "hi" })]')).toBe(
      "(earlier reply omitted: it was malformed)",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(stripFakeToolCalls("[tools: search ×2] and [link](x)")).toBe(
      "[tools: search ×2] and [link](x)",
    );
  });
});
