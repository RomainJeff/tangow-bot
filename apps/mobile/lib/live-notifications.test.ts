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
  notificationTargetsThread,
  setOpenNotificationThread,
  syncAppBadge,
} from "./live-notifications";

beforeEach(() => vi.clearAllMocks());

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

    // The badge carries the server's unread total, so it applies even when the banner is
    // hidden for the open agent.
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
