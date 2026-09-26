import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock("expo", () => ({ requireNativeModule: vi.fn() }));
vi.mock("expo-notifications", () => ({
  setNotificationHandler: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(async () => []),
  setBadgeCountAsync: vi.fn(async () => true),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import * as Notifications from "expo-notifications";
import {
  configureForegroundNotifications,
  destinationIsOnScreen,
  notificationDestination,
  notificationTargetsThread,
  setOpenNotificationThread,
  syncAppBadge,
} from "./live-notifications";

beforeEach(() => vi.clearAllMocks());

describe("notification destination", () => {
  it("opens the bot's chat in the space it came from", () => {
    expect(notificationDestination({ botId: "bot-1", threadId: "t", spaceId: "s" })).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1", spaceId: "s" },
    });
    expect(notificationDestination({ botId: "bot-1" })).toEqual({
      pathname: "/thread",
      params: { botId: "bot-1" },
    });
  });

  it("opens the group when the bot spoke in one", () => {
    expect(notificationDestination({ botId: "bot-1", groupId: "g", spaceId: "s" })).toEqual({
      pathname: "/group-thread",
      params: { groupId: "g", spaceId: "s" },
    });
  });

  it("ignores a push without a conversation", () => {
    expect(notificationDestination({})).toBeNull();
    expect(notificationDestination(undefined)).toBeNull();
    expect(notificationDestination({ botId: 3 })).toBeNull();
  });
});

describe("notification destination on screen", () => {
  const chat = { pathname: "/thread", params: { botId: "bot-1", spaceId: "s" } } as const;
  const group = { pathname: "/group-thread", params: { groupId: "g" } } as const;

  it("recognises the conversation already open", () => {
    expect(destinationIsOnScreen(chat, "/thread", { botId: "bot-1", name: "Maya" })).toBe(true);
    expect(destinationIsOnScreen(group, "/group-thread", { groupId: "g" })).toBe(true);
  });

  it("opens anything else", () => {
    expect(destinationIsOnScreen(chat, "/", {})).toBe(false);
    expect(destinationIsOnScreen(chat, "/thread", { botId: "bot-2" })).toBe(false);
    expect(destinationIsOnScreen(chat, "/thread", { botId: "bot-1", groupId: "g" })).toBe(false);
    expect(destinationIsOnScreen(group, "/group-thread", { groupId: "h" })).toBe(false);
  });
});

describe("notification thread targeting", () => {
  it("matches Expo and native notification keys for the open agent", () => {
    expect(notificationTargetsThread({ botId: "bot-1" }, { botId: "bot-1" })).toBe(true);
    expect(
      notificationTargetsThread(
        { "rakazo.threadId": "thread-1" },
        { botId: "bot-1", threadId: "thread-1" },
      ),
    ).toBe(true);
  });

  it("keeps other agents visible", () => {
    expect(notificationTargetsThread({ botId: "bot-2" }, { botId: "bot-1" })).toBe(false);
    expect(notificationTargetsThread({ botId: "bot-1" }, null)).toBe(false);
  });

  it("does not confuse an open DM with a group notification from the same agent", () => {
    expect(
      notificationTargetsThread(
        { botId: "bot-1", threadId: "group-thread" },
        { botId: "bot-1", threadId: "dm-thread" },
      ),
    ).toBe(false);
  });

  it("hides only foreground notifications for the open agent", async () => {
    configureForegroundNotifications();
    await setOpenNotificationThread({ botId: "bot-1" });
    const handler = vi.mocked(Notifications.setNotificationHandler).mock.calls[0]?.[0];
    expect(handler).toBeTruthy();

    await expect(
      handler?.handleNotification({ request: { content: { data: { botId: "bot-1" } } } } as never),
    ).resolves.toMatchObject({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldSetBadge: true,
    });
    await expect(
      handler?.handleNotification({ request: { content: { data: { botId: "bot-2" } } } } as never),
    ).resolves.toMatchObject({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldSetBadge: true,
    });
  });
});

describe("app icon badge", () => {
  it("sets the badge to the unread conversation total on iOS", async () => {
    await syncAppBadge(3);
    expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(3);
    await syncAppBadge(0);
    expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(0);
  });
});
