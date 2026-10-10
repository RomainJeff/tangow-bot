// @vitest-environment jsdom
import type { BotActivityItem, BotActivityOutput, RunActivityRow } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ bots: { activity: vi.fn() }, runs: { recap: vi.fn() } }));
vi.mock("../../lib/rpc", () => ({ rpc: api }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values);
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray, ...values: unknown[]) => String.raw(parts, ...values),
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));

import { BotActivity } from "./BotActivity";

const NOW = Date.UTC(2026, 9, 6, 12, 0);

function run(id: string, minutesAgo: number, extra: Partial<RunActivityRow> = {}): BotActivityItem {
  const at = new Date(NOW - minutesAgo * 60_000).toISOString();
  return {
    kind: "routine_run",
    run: {
      runId: id,
      botId: "bot-1",
      botName: "Scout",
      groupId: null,
      groupName: null,
      threadId: "thread-1",
      status: "completed",
      trigger: "routine",
      notificationsEnabled: false,
      promptSnippet: "",
      createdAt: at,
      updatedAt: at,
      routineId: "r-1",
      routineName: "Sweep",
      sourceMessageId: null,
      startedAt: at,
      completedAt: at,
      failureKind: null,
      ...extra,
    },
  };
}

function page(
  items: BotActivityItem[],
  next: BotActivityOutput["nextCursor"] = null,
): BotActivityOutput {
  return { items, nextCursor: next };
}

let container: HTMLElement;
let root: Root;
const openRun = vi.fn();
const openRoutine = vi.fn();

async function render(epoch = 0) {
  await act(async () =>
    root.render(
      <BotActivity
        botId="bot-1"
        commands={{ activityEpoch: epoch, openRun }}
        onOpenRoutine={openRoutine}
      />,
    ),
  );
}

const lines = () =>
  [...container.querySelectorAll('[data-testid="activity-run"]')].map((line) =>
    line.getAttribute("aria-label"),
  );
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === text);
const recapText = () => container.querySelector('[data-testid="activity-recap"]')?.textContent;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
});

it("appends the earlier page under the first, each entry once", async () => {
  const cursor = { createdAt: "2026-10-06T11:00:00.000Z", id: "run-2" };
  api.bots.activity
    .mockResolvedValueOnce(page([run("run-1", 10, { routineId: "r-2" }), run("run-2", 60)], cursor))
    .mockResolvedValueOnce(
      page([
        run("run-2", 60),
        run("run-3", 120, { status: "failed", failureKind: "missing_model" }),
      ]),
    );
  await render();
  expect(lines()).toHaveLength(2);

  await act(async () => button("Show earlier")?.click());

  expect(api.bots.activity.mock.calls).toEqual([
    [{ botId: "bot-1" }],
    [{ botId: "bot-1", cursor }],
  ]);
  expect(lines()).toHaveLength(3);
  expect(lines()[2]).toMatch(/^Sweep, No model connected, Failed, /);
  expect(button("Show earlier")).toBeUndefined();
});

it("reads the list again when a run ends", async () => {
  api.bots.activity
    .mockResolvedValueOnce(page([]))
    .mockResolvedValueOnce(page([run("run-1", 1, { routineName: null, routineId: null })]));
  await render(0);
  expect(container.textContent).toContain("No activity yet");

  await render(1);

  expect(api.bots.activity).toHaveBeenCalledTimes(2);
  expect(lines()).toEqual([expect.stringMatching(/^Routine, Done, /)]);
});

it("opens a run's recap in place, then the chat at the message it posted", async () => {
  api.bots.activity.mockResolvedValueOnce(page([run("run-7", 5)]));
  api.runs.recap.mockResolvedValueOnce({ text: "**3 invoices** are late", messageId: "m-9" });
  await render();
  const line = container.querySelector<HTMLButtonElement>('[data-testid="activity-run"]')!;
  expect(line.getAttribute("aria-expanded")).toBe("false");

  await act(async () => line.click());

  expect(line.getAttribute("aria-expanded")).toBe("true");
  expect(api.runs.recap).toHaveBeenCalledWith({ runId: "run-7" });
  expect(container.querySelector('[data-testid="activity-recap"] strong')?.textContent).toBe(
    "3 invoices",
  );
  expect(openRun).not.toHaveBeenCalled();

  await act(async () => button("Open in chat")?.click());

  expect(openRun.mock.calls).toEqual([[{ botId: "bot-1", groupId: null, sourceMessageId: "m-9" }]]);
});

it("says a failed run's reason once, on its line, and shows only what it wrote below", async () => {
  api.bots.activity.mockResolvedValueOnce(
    page([run("quiet", 5), run("broken", 10, { status: "failed", failureKind: "computer" })]),
  );
  api.runs.recap
    .mockResolvedValueOnce({ text: "Checked 3 of 5 folders.", messageId: "m-3" })
    .mockResolvedValueOnce({ text: null, messageId: null });
  await render();
  const [quiet, broken] = container.querySelectorAll<HTMLButtonElement>(
    '[data-testid="activity-run"]',
  );
  expect(broken?.textContent).toContain("Computer unavailable");

  await act(async () => broken!.click());
  expect(recapText()).toBe("Checked 3 of 5 folders.Open in chat");

  await act(async () => broken!.click());
  await act(async () => quiet!.click());
  expect(recapText()).toBe("No reportOpen in chat");
});

it("keeps Open in chat when the recap cannot be read, opening where the run began", async () => {
  api.bots.activity.mockResolvedValueOnce(
    page([
      run("broken", 10, { status: "failed", failureKind: "computer", sourceMessageId: "m-1" }),
    ]),
  );
  api.runs.recap.mockRejectedValueOnce(new Error("offline"));
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="activity-run"]')!.click(),
  );
  expect(recapText()).toBe("Could not load · RetryOpen in chat");

  await act(async () => button("Open in chat")?.click());

  expect(openRun.mock.calls).toEqual([[{ botId: "bot-1", groupId: null, sourceMessageId: "m-1" }]]);
});

it("cuts a long recap and shows the rest in place", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 1_000,
  });
  api.bots.activity.mockResolvedValueOnce(page([run("run-1", 5)]));
  api.runs.recap.mockResolvedValueOnce({ text: "A long report", messageId: "m-1" });
  await render();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="activity-run"]')!.click(),
  );
  const clip = () => container.querySelector<HTMLElement>('[data-slot="clipped-preview"]');
  const showMore = () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Show more"]');
  expect(clip()?.style.maxHeight).toBe("184px");

  await act(async () => showMore()?.click());

  expect(clip()).toBeNull();
  expect(showMore()).toBeNull();
  expect(recapText()).toContain("A long report");
});

it("folds a routine's successful runs in a row and keeps a failure on its own line", async () => {
  api.bots.activity.mockResolvedValueOnce(
    page([
      run("run-1", 10),
      run("run-2", 20),
      run("run-3", 30),
      run("run-4", 40, { status: "failed", failureKind: "missing_model" }),
    ]),
  );
  await render();

  const folded = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(folded.getAttribute("aria-label")).toMatch(/^Sweep, 3 runs, Done, /);
  expect(lines()).toEqual([expect.stringMatching(/^Sweep, No model connected, Failed, /)]);

  await act(async () => folded.click());

  expect(folded.getAttribute("aria-expanded")).toBe("true");
  expect(lines()).toHaveLength(4);
});

it("lists the routines the bot was given and its own creation, and opens a routine", async () => {
  api.bots.activity.mockResolvedValueOnce(
    page([
      {
        kind: "routine_created",
        routineId: "r-2",
        routineName: "Inbox sweep",
        createdAt: "2026-10-05T09:00:00.000Z",
        byBotName: "Scout",
      },
      {
        kind: "routine_created",
        routineId: "r-1",
        routineName: "Digest",
        createdAt: "2026-10-04T09:00:00.000Z",
        byBotName: null,
      },
      {
        kind: "bot_created",
        botId: "bot-1",
        botName: "Scout",
        createdAt: "2026-10-04T08:00:00.000Z",
      },
    ]),
  );
  await render();
  const created = [...container.querySelectorAll('[data-testid="activity-created"]')];
  expect(created.map((line) => line.textContent?.replace(/\d{1,2}:\d{2}.*$/, ""))).toEqual([
    "Inbox sweep · Routine created by Scout",
    "Digest · Routine created",
    "Scout created",
  ]);
  expect(created[2]?.tagName).toBe("DIV");

  await act(async () => (created[0] as HTMLButtonElement).click());

  expect(openRoutine.mock.calls).toEqual([["r-2"]]);
});

it("reads an open run's recap again once the run ends", async () => {
  api.bots.activity
    .mockResolvedValueOnce(page([run("run-1", 1, { status: "running", completedAt: null })]))
    .mockResolvedValueOnce(page([run("run-1", 1)]));
  api.runs.recap
    .mockResolvedValueOnce({ text: null, messageId: null })
    .mockResolvedValueOnce({ text: "Inbox is clear.", messageId: "m-1" });
  await render(0);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="activity-run"]')!.click(),
  );
  expect(recapText()).toBe("No reportOpen in chat");

  await render(1);

  expect(lines()).toEqual([expect.stringMatching(/^Sweep, Done, /)]);
  expect(recapText()).toBe("Inbox is clear.Open in chat");
});

it("offers a retry when the list cannot be read", async () => {
  api.bots.activity.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(page([]));
  await render();
  expect(container.textContent).toContain("Could not load · Retry");

  await act(async () => button("Retry")?.click());

  expect(container.textContent).toContain("No activity yet");
});
