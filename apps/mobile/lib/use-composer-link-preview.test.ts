vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));

import { afterEach, expect, it, vi } from "vitest";
import { previewComposerLink } from "./use-composer-link-preview";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("waits for a server read that takes 9.5 s, inside the server's own 10 s deadline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
          setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ json: { deviceReadable: true } }), {
                  headers: { "content-type": "application/json" },
                }),
              ),
            9_500,
          );
        }),
    ),
  );

  const pending = previewComposerLink(
    "thread-1",
    "https://slow.example.com/a",
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(9_500);

  await expect(pending).resolves.toEqual({ deviceReadable: true });
});
