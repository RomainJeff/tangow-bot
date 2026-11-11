import { describe, expect, it } from "vitest";
import {
  hasMentionToken,
  inferHandoffTargetBotId,
  inferHandoffTargetName,
  resolveGroupTargetBotIds,
} from "./group-mentions.js";

const members = [
  { id: "a", name: "BotA" },
  { id: "b", name: "BotB" },
  { id: "c", name: "Writer" },
];
const usableBotIds = new Set(["a", "b", "c"]);

describe("hasMentionToken", () => {
  it("requires a boundary after the complete member name", () => {
    expect(hasMentionToken("Ask @Ann to review", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Ann, then continue", "Ann")).toBe(true);
    expect(hasMentionToken("Ask @Anna to review", "Ann")).toBe(false);
    expect(hasMentionToken("name@Ann", "Ann")).toBe(false);
    expect(hasMentionToken("contact@everyone", "everyone")).toBe(false);
  });

  it("supports multi-word and Unicode member names", () => {
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Research Writer")).toBe(true);
    expect(hasMentionToken("Ask @Research Writer and @Éditeur", "Éditeur")).toBe(true);
  });
});

describe("resolveGroupTargetBotIds", () => {
  it("returns mentioned bots from text", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@BotA gather sources. @BotB summarize.",
        members,
        usableBotIds,
      }),
    ).toEqual(["a", "b"]);
  });

  it("returns all members for @everyone", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@everyone please review",
        members,
        usableBotIds,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("merges explicit mentions", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b"],
        usableBotIds,
      }),
    ).toEqual(["b"]);
  });

  it("matches multi-word and Unicode names without prefix collisions", () => {
    const namedMembers = [
      { id: "research", name: "Research Writer" },
      { id: "edit", name: "Éditeur" },
      { id: "ann", name: "Ann" },
      { id: "anna", name: "Anna" },
    ];
    expect(
      resolveGroupTargetBotIds({
        text: "@Research Writer compare this with @Éditeur and @Anna.",
        members: namedMembers,
        usableBotIds: new Set(namedMembers.map((member) => member.id)),
      }),
    ).toEqual(["research", "edit", "anna"]);
  });

  it("ignores explicit mentions for bots that are not group members", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b", "outsider"],
        usableBotIds,
      }),
    ).toEqual(["b"]);
  });

  it("wakes the lead when unmentioned, or the first member once the lead is gone", () => {
    const wake = (leadBotId: string | null) =>
      resolveGroupTargetBotIds({ text: "hello team", members, leadBotId, usableBotIds });
    expect(wake("b")).toEqual(["b"]);
    expect(wake("gone")).toEqual(["a"]);
  });

  it("wakes only the bots the sender can use, and nothing when the lead is not one", () => {
    const wake = (text: string, explicitMentions?: string[]) =>
      resolveGroupTargetBotIds({
        text,
        members,
        explicitMentions,
        usableBotIds: new Set(["b"]),
      });
    expect(wake("@everyone review")).toEqual(["b"]);
    expect(wake("@BotA and @BotB", ["a"])).toEqual(["b"]);
    expect(wake("hello team")).toEqual([]);
    expect(wake("@BotA look")).toEqual([]);
  });
});

describe("inferHandoffTargetName", () => {
  it("picks Writer when BotA is also mentioned", () => {
    expect(inferHandoffTargetName("@BotA hand this to Writer for the draft")).toBe("Writer");
  });
});

describe("inferHandoffTargetBotId", () => {
  it("recognizes hand this to Writer", () => {
    expect(inferHandoffTargetBotId("hand this to Writer for the draft", members)).toBe("c");
  });

  it("recognizes @Writer take the draft", () => {
    expect(inferHandoffTargetBotId("@Writer take the draft", members)).toBe("c");
  });

  it("resolves Writer from mixed mention prompt", () => {
    expect(inferHandoffTargetBotId("@BotA hand this to Writer for the draft", members)).toBe("c");
  });

  it("resolves multi-word handoff targets", () => {
    expect(
      inferHandoffTargetBotId("hand this to Research Writer for the draft", [
        ...members,
        { id: "research", name: "Research Writer" },
      ]),
    ).toBe("research");
  });
});
