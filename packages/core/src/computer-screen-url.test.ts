import type { ComputerStatus } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import type { HeldScreenUrl } from "./computer-screen-url.js";
import {
  computerScreenKey,
  isScreenUrlReusable,
  SCREEN_PROXY_TTL_MS,
  SCREEN_URL_RENEW_MS,
} from "./computer-screen-url.js";

const status: ComputerStatus = {
  botId: "bot-1",
  mode: "team",
  kind: "fake",
  state: "running",
  controlHolder: "bot",
  controlBotId: "bot-1",
  takeoverRequested: false,
  screenAvailable: true,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: "rev-1",
  screenStamp: "0123456789abcdef",
  busyBotName: null,
  canUpdate: false,
};

const held: HeldScreenUrl = { url: "/screen/a", key: computerScreenKey(status), readAt: 1000 };

describe("computerScreenKey", () => {
  it.each<[string, Partial<ComputerStatus>]>([
    ["state", { state: "booting" }],
    ["mode", { mode: "dedicated" }],
    ["kind", { kind: "docker" }],
    ["controlHolder", { controlHolder: "user" }],
    ["controlBotId", { controlBotId: "bot-2" }],
    ["screenAvailable", { screenAvailable: false }],
    ["screenWidth", { screenWidth: 1024 }],
    ["screenHeight", { screenHeight: 600 }],
    ["screenStamp", { screenStamp: "fedcba9876543210" }],
  ])("changes with %s", (_field, change) => {
    expect(computerScreenKey({ ...status, ...change })).not.toBe(computerScreenKey(status));
  });

  it("ignores fields that do not change the screen", () => {
    expect(
      computerScreenKey({
        ...status,
        takeoverRequested: true,
        homeRevision: "rev-2",
        busyBotName: "Writer",
        canUpdate: true,
      }),
    ).toBe(computerScreenKey(status));
  });
});

describe("isScreenUrlReusable", () => {
  it("reuses a held URL for the same key", () => {
    expect(isScreenUrlReusable(held, status, 2000)).toBe(true);
  });

  it("keeps a held null URL reusable", () => {
    expect(isScreenUrlReusable({ ...held, url: null }, status, 2000)).toBe(true);
  });

  it("rejects a changed key", () => {
    expect(isScreenUrlReusable(held, { ...status, screenStamp: "fedcba9876543210" }, 2000)).toBe(
      false,
    );
  });

  it("rejects a missing held URL or status", () => {
    expect(isScreenUrlReusable(undefined, status, 2000)).toBe(false);
    expect(isScreenUrlReusable(held, null, 2000)).toBe(false);
    expect(isScreenUrlReusable(held, undefined, 2000)).toBe(false);
  });

  it("expires at the renew age", () => {
    expect(isScreenUrlReusable(held, status, 1000 + SCREEN_URL_RENEW_MS - 1)).toBe(true);
    expect(isScreenUrlReusable(held, status, 1000 + SCREEN_URL_RENEW_MS)).toBe(false);
  });

  it("takes a caller age limit", () => {
    expect(
      isScreenUrlReusable(held, status, 1000 + SCREEN_PROXY_TTL_MS - 1, SCREEN_PROXY_TTL_MS),
    ).toBe(true);
    expect(isScreenUrlReusable(held, status, 1000 + SCREEN_PROXY_TTL_MS, SCREEN_PROXY_TTL_MS)).toBe(
      false,
    );
  });
});
