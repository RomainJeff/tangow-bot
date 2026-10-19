// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  threads: { markRead: vi.fn(async () => undefined), markUnread: vi.fn() },
  spaces: { list: vi.fn() },
  bots: { listArchived: vi.fn(async () => []), reorder: vi.fn() },
  groups: { listArchived: vi.fn(async () => []) },
}));
const bot = (id: string) => ({ id, name: id, unread: true });
const BOTS = [bot("A"), bot("B")];
vi.mock("../../lib/rpc", () => ({ rpc }));
vi.mock("../../lib/performance", () => ({ markOnce: () => undefined }));
vi.mock("../../lib/bootstrap", () => ({
  takeInitialBootstrap: async () => ({
    me: {},
    bots: BOTS,
    botSections: [],
    archivedBots: [],
    archivedGroups: [],
    groups: [],
    spaces: [{ hasContent: true }],
    thread: { botId: "A" },
    routines: [],
  }),
}));

import { useRoster } from "./use-roster";

let phone = true;
let latest: ReturnType<typeof useRoster>;
let root: Root;
const navigate = vi.fn();

function Roster({ botId }: { botId?: string }) {
  latest = useRoster({ botId, groupId: undefined, navigate, onBootstrapThread: () => undefined });
  return null;
}

async function show(botId?: string) {
  await act(async () => root.render(createElement(Roster, { botId })));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width: 767px") ? phone : !phone,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  rpc.spaces.list.mockResolvedValue({
    current: { bots: BOTS, botSections: [], groups: [] },
    spaces: [{ hasContent: true }],
  });
  navigate.mockReset();
  rpc.threads.markRead.mockClear();
  phone = true;
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("leaves the phone's bot list on its own page, reading no chat behind it", async () => {
  await show();
  expect(navigate).not.toHaveBeenCalled();
  expect(rpc.threads.markRead).not.toHaveBeenCalled();

  // Into the chat the list kept behind it: only the route changes, and the chat is read.
  await show("A");
  expect(rpc.threads.markRead).toHaveBeenCalledWith({ botId: "A" });
});

it("reopens the last chat, not the first bot, when the list widens to desktop", async () => {
  await show("B");
  await show();
  expect(latest.active?.id).toBe("B");
  phone = false;
  await act(async () => {
    await latest.refreshBots();
  });
  expect(navigate).toHaveBeenLastCalledWith("/app/B", { replace: true });
});
