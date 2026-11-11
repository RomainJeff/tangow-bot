import type { SearchHit } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { mobileSearchDestination } from "./search-destination.js";

describe("mobileSearchDestination", () => {
  const base = {
    botId: "bot-1",
    botName: "Scout",
    title: "Result",
    snippet: "match",
  } as const;

  it("opens message matches in their thread", () => {
    const hit: SearchHit = { ...base, kind: "message", messageId: "message-1", seq: 4 };
    expect(mobileSearchDestination(hit)).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", name: "Scout", messageId: "message-1" },
    });
  });

  it("opens routine matches on the routine's screen", () => {
    const hit: SearchHit = { ...base, kind: "routine", routineId: "routine-1" };
    expect(mobileSearchDestination(hit)).toEqual({
      pathname: "/bot-routine",
      params: { botId: "bot-1", routineId: "routine-1" },
    });
  });

  it("opens a routine match on a bot shared with you in your own thread", () => {
    const hit: SearchHit = { ...base, kind: "routine", routineId: "routine-1" };
    expect(mobileSearchDestination(hit, true)).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", name: "Scout" },
    });
  });

  it("opens group matches in the group thread", () => {
    const hit: SearchHit = {
      kind: "message",
      groupId: "group-1",
      groupName: "Squad",
      title: "Squad",
      snippet: "match",
      messageId: "message-1",
      seq: 2,
    };
    expect(mobileSearchDestination(hit)).toEqual({
      pathname: "/group-thread",
      params: { groupId: "group-1", name: "Squad", messageId: "message-1" },
    });
  });
});
