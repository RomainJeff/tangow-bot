import { describe, expect, it } from "vitest";
import { runOpening } from "./bot-activity";

const row = {
  botId: "bot-1",
  botName: "Scout",
  groupId: null,
  groupName: null,
  sourceMessageId: "message-1",
};

describe("opening a run from the bot's activity", () => {
  it("goes back to the bot's thread below, at the message the run left", () => {
    const routes = [
      { name: "index" },
      { name: "thread", params: { botId: "bot-1", name: "Scout" } },
      { name: "bot", params: { botId: "bot-1" } },
      { name: "bot-routine", params: { botId: "bot-1", routineId: "routine-1" } },
    ];
    expect(runOpening(routes, row)).toEqual({
      via: "dismissTo",
      to: {
        pathname: "/thread",
        params: { botId: "bot-1", name: "Scout", messageId: "message-1" },
      },
    });
  });

  it("opens a group run on top, at the latest messages, when its group is not below", () => {
    const routes = [
      { name: "index" },
      { name: "thread", params: { botId: "bot-1", name: "Scout" } },
      { name: "bot", params: { botId: "bot-1" } },
    ];
    expect(
      runOpening(routes, { ...row, groupId: "group-1", groupName: "Ops", sourceMessageId: null }),
    ).toEqual({
      via: "push",
      to: { pathname: "/group-thread", params: { groupId: "group-1", name: "Ops" } },
    });
  });

  it("opens on top rather than turn another bot's thread below into this one", () => {
    const routes = [
      { name: "index" },
      { name: "thread", params: { botId: "bot-2", name: "Echo" } },
      { name: "bot-routine", params: { botId: "bot-1", routineId: "routine-1" } },
    ];
    expect(runOpening(routes, row).via).toBe("push");
  });

  it("goes back to the group below when the run is that group's", () => {
    const routes = [
      { name: "index" },
      { name: "group-thread", params: { groupId: "group-1", name: "Ops" } },
      { name: "bot", params: { botId: "bot-1" } },
    ];
    expect(runOpening(routes, { ...row, groupId: "group-1", groupName: "Ops" })).toEqual({
      via: "dismissTo",
      to: {
        pathname: "/group-thread",
        params: { groupId: "group-1", name: "Ops", messageId: "message-1" },
      },
    });
  });
});
