import type { ProductEvent } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserNotificationApi,
  type BrowserNotificationContext,
  browserNotificationMessage,
  deliverBrowserNotification,
  requestBrowserNotificationPermission,
  shouldNotifyBrowser,
} from "./browser-notifications.js";
import { i18n } from "./i18n.js";

function appended(type: "assistant.text" | "user.message", text: string) {
  const entry = SessionEntrySchema.parse({
    id: "entry-1",
    sessionId: "session-1",
    seq: 3,
    parentId: "parent",
    ts: "2026-10-11T08:00:00.000Z",
    ...(type === "assistant.text"
      ? { botId: "bot-1", runId: "run-1", type, payload: { blocks: [{ kind: "text", text }] } }
      : { type, payload: { blocks: [{ kind: "text", text }], source: "app" } }),
  });
  return { entries: [entry] };
}

function event(overrides: Partial<ProductEvent> = {}): ProductEvent {
  return {
    type: "session.entry.appended",
    id: "event-1",
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId: "run-1",
    seq: 8,
    createdAt: "2026-10-11T08:00:00.000Z",
    payload: appended("assistant.text", "The pool is balanced."),
    ...overrides,
  };
}

function context(overrides: Partial<BrowserNotificationContext> = {}): BrowserNotificationContext {
  return {
    subscribedThreadId: "thread-1",
    initialCursor: 7,
    streamReady: true,
    pageVisible: false,
    windowFocused: false,
    permission: "granted",
    notifiedEventIds: new Set(),
    ...overrides,
  };
}

describe("browser notifications", () => {
  beforeEach(() => {
    i18n.load("en", {
      "{name} failed": "Chief failed",
      "{name} finished": "Chief finished",
      "{name} stopped": "Chief stopped",
      "Failed.": "Failed.",
      "Stopped.": "Stopped.",
      "Finished.": "Finished.",
    });
    i18n.activate("en");
  });

  it("only accepts a new bot message for the hidden or unfocused subscribed thread", () => {
    expect(shouldNotifyBrowser(event(), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ type: "run.started" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ type: "run.failed" }), context())).toBe(true);
    expect(shouldNotifyBrowser(event({ type: "run.cancelled" }), context())).toBe(true);
    expect(
      shouldNotifyBrowser(event({ payload: appended("user.message", "Thanks") }), context()),
    ).toBe(false);
    expect(shouldNotifyBrowser(event({ type: "run.completed" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ threadId: "other-thread" }), context())).toBe(false);
    expect(shouldNotifyBrowser(event({ seq: 7 }), context())).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ pageVisible: true, windowFocused: false }))).toBe(
      true,
    );
    expect(shouldNotifyBrowser(event(), context({ pageVisible: false, windowFocused: true }))).toBe(
      true,
    );
    expect(shouldNotifyBrowser(event(), context({ streamReady: false }))).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ pageVisible: true, windowFocused: true }))).toBe(
      false,
    );
    expect(shouldNotifyBrowser(event(), context({ permission: "default" }))).toBe(false);
    expect(shouldNotifyBrowser(event(), context({ notifiedEventIds: new Set(["event-1"]) }))).toBe(
      false,
    );
  });

  it("shows the bot message's words without its markdown, cut for a notification", () => {
    const text = `**Done**: see [the report](https://example.test/r)\n- one\n- two ${"word ".repeat(60)}`;
    const { body } = browserNotificationMessage(
      event({ payload: appended("assistant.text", text) }),
      "Chief",
    );
    expect(body).toBe(`Done: see the report one two ${"word ".repeat(30).trim()}…`);
  });

  it("puts the bot message in the native notification", () => {
    expect(browserNotificationMessage(event(), "Chief")).toEqual({
      title: "Chief",
      body: "The pool is balanced.",
    });
    expect(browserNotificationMessage(event({ type: "run.failed" }), "Chief")).toEqual({
      title: "Chief failed",
      body: "Failed.",
    });
    expect(browserNotificationMessage(event({ type: "run.cancelled" }), "Chief")).toEqual({
      title: "Chief stopped",
      body: "Stopped.",
    });
  });

  it("dedupes a replay but delivers another message from the same run", () => {
    const notifiedEventIds = new Set<string>();
    const show = vi.fn().mockImplementationOnce(() => {
      throw new Error("notification construction failed");
    });
    const delivery = (permission: "default" | "granted", nextEvent = event()) =>
      deliverBrowserNotification(nextEvent, "Chief", {
        enabled: true,
        pageVisible: false,
        windowFocused: false,
        permission,
        notifiedEventIds,
        show,
      });

    expect(delivery("default")).toBe("pending");
    expect(delivery("granted")).toBe("pending");
    expect(notifiedEventIds).toEqual(new Set());
    expect(delivery("granted")).toBe("delivered");
    expect(notifiedEventIds).toEqual(new Set(["event-1"]));
    expect(show).toHaveBeenLastCalledWith("Chief", "The pool is balanced.", "thread-1");
    expect(delivery("granted")).toBe("discarded");
    expect(delivery("granted", event({ id: "event-2" }))).toBe("delivered");
    expect(show).toHaveBeenCalledTimes(3);
  });

  it("allows a later send gesture to retry a dismissed permission prompt", async () => {
    let resolvePermission: ((permission: "default") => void) | undefined;
    const requestPermission = vi.fn(
      () =>
        new Promise<"default">((resolve) => {
          resolvePermission = resolve;
        }),
    );
    const api: BrowserNotificationApi = { permission: "default", requestPermission };

    requestBrowserNotificationPermission(api);
    requestBrowserNotificationPermission(api);
    expect(requestPermission).toHaveBeenCalledTimes(1);

    resolvePermission?.("default");
    await Promise.resolve();
    requestBrowserNotificationPermission(api);
    expect(requestPermission).toHaveBeenCalledTimes(2);
  });
});
