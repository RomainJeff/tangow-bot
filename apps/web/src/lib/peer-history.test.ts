import type { EntryId, SessionEntry } from "@rakazo/contracts";
import { SessionEntrySchema } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPeerHistory } from "./peer-history";

function said(id: string, seq: number): SessionEntry {
  return SessionEntrySchema.parse({
    id,
    sessionId: "session-1",
    seq,
    parentId: null,
    ts: "2026-10-11T08:00:00.000Z",
    type: "user.message",
    payload: { blocks: [{ kind: "text", text: id }], source: "app" },
  });
}

afterEach(() => vi.useRealTimers());

describe("peer history loading", () => {
  it("collects paginated entries oldest first, each once", async () => {
    const loadPage = vi
      .fn()
      .mockResolvedValueOnce({ entries: [said("mid", 2), said("new", 3)], olderCursor: "mid" })
      .mockResolvedValueOnce({ entries: [said("old", 1), said("mid", 2)], olderCursor: null });

    const entries = await loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
    });

    expect(entries.map(({ id }) => id)).toEqual(["old", "mid", "new"]);
    expect(loadPage.mock.calls.map(([before]) => before)).toEqual([undefined, "mid"]);
  });

  it("aborts a page that never settles before the full-history deadline", async () => {
    vi.useFakeTimers();
    const loadPage = vi.fn(
      (_before: EntryId | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
      pageTimeoutMs: 100,
      totalTimeoutMs: 1_000,
    });
    const rejected = expect(loading).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("bounds the full-history scan independently of the per-page timeout", async () => {
    vi.useFakeTimers();
    const loadPage = vi.fn(
      (_before: EntryId | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({
      signal: new AbortController().signal,
      loadPage,
      pageTimeoutMs: 1_000,
      totalTimeoutMs: 100,
    });
    const rejected = expect(loading).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
  });

  it("aborts an in-flight page when the viewer closes", async () => {
    const lifecycle = new AbortController();
    const loadPage = vi.fn(
      (_before: EntryId | undefined, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );

    const loading = loadPeerHistory({ signal: lifecycle.signal, loadPage });
    const rejected = expect(loading).rejects.toMatchObject({ name: "AbortError" });
    lifecycle.abort();

    await rejected;
  });
});
