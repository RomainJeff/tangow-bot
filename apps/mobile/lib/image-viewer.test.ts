import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearImageViewerPayload,
  holdThreadForViewer,
  imageViewerPayload,
  setImageViewerPayload,
  useThreadHeldByImageViewer,
} from "./image-viewer";

vi.mock("react", () => ({
  useSyncExternalStore: (_subscribe: unknown, read: () => boolean) => read(),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios", Version: "26.0" } }));
vi.mock("./chat-motion", () => ({ useChatReducedMotion: () => false }));
vi.mock("./i18n", () => ({ t: (text: string) => text }));

describe("thread hold while the image viewer is open", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it("stays held until every viewer has released", () => {
    const releaseFirst = holdThreadForViewer();
    const releaseSecond = holdThreadForViewer();
    expect(useThreadHeldByImageViewer()).toBe(true);

    releaseFirst();
    vi.advanceTimersByTime(700);
    expect(useThreadHeldByImageViewer()).toBe(true);

    releaseSecond();
    vi.advanceTimersByTime(700);
    expect(useThreadHeldByImageViewer()).toBe(false);
  });

  it("lets go only 700 ms after the last release", () => {
    const release = holdThreadForViewer();
    release();
    vi.advanceTimersByTime(699);
    expect(useThreadHeldByImageViewer()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(useThreadHeldByImageViewer()).toBe(false);
  });
});

describe("image viewer payload", () => {
  it("is handed over once and gone after clearing", () => {
    setImageViewerPayload({
      images: [],
      startIndex: 2,
      author: "Ada",
      target: { botId: "bot-1" },
      zoomed: true,
    });
    expect(imageViewerPayload()?.startIndex).toBe(2);
    expect(imageViewerPayload()?.zoomed).toBe(true);

    clearImageViewerPayload();
    expect(imageViewerPayload()).toBeNull();
  });
});
