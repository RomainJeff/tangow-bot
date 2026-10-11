import { describe, expect, it } from "vitest";
import { runDestination } from "./bot-activity";

const row = {
  botId: "bot-1",
  botName: "Scout",
  groupId: null,
  groupName: null,
  sourceMessageId: "message-1",
};

describe("opening a run from the bot's activity", () => {
  it("opens the bot's thread at the message the run left", () => {
    expect(runDestination(row)).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", name: "Scout", messageId: "message-1" },
    });
  });

  it("opens a group run in its group, at the latest messages when none is known", () => {
    expect(
      runDestination({ ...row, groupId: "group-1", groupName: "Ops", sourceMessageId: null }),
    ).toEqual({ pathname: "/group-thread", params: { groupId: "group-1", name: "Ops" } });
  });
});
