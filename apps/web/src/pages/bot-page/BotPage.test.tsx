// @vitest-environment jsdom
import type { Bot, Routine } from "@tangow/contracts";
import { createSaveStore } from "@tangow/core";
import { SaveStoreProvider } from "@tangow/ui-web";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotCommands } from "../shell/bot-commands";
import type { BotPageView } from "../shell/layout";

const api = vi.hoisted(() => ({
  bots: { activity: vi.fn(), list: vi.fn(), sharing: vi.fn() },
  runs: { recap: vi.fn() },
  memory: { list: vi.fn(), update: vi.fn() },
  agentSkills: { list: vi.fn(), get: vi.fn(), update: vi.fn(), remove: vi.fn() },
  computer: { files: vi.fn() },
  scratchpad: { list: vi.fn() },
  models: { credentials: vi.fn(), list: vi.fn(), routing: vi.fn() },
  me: vi.fn(),
  voice: { voices: vi.fn() },
}));
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

import { BotPage } from "./BotPage";

const BOT = {
  id: "bot-1",
  spaceId: "space-1",
  name: "Scout",
  title: "Watches the inbox",
  description: "",
  instructions: "Flag what needs a person.",
  color: "#3BC9A0",
  shapeSeed: null,
  notifyOnFinish: true,
  status: "idle",
  computerMode: "team",
  voiceId: null,
  autoSpeak: false,
  chattyReplies: false,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  memoryScope: null,
  archivedAt: null,
} as unknown as Bot;

const store = createSaveStore();
let container: HTMLElement;
let root: Root;
let updateBot: ReturnType<typeof vi.fn>;
let refresh: ReturnType<typeof vi.fn<(botId: string) => Promise<void>>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  api.bots.activity.mockResolvedValue({ items: [], nextCursor: null });
  api.bots.sharing.mockResolvedValue({ visibility: "private", userIds: [], connectors: [] });
  api.models.credentials.mockResolvedValue([]);
  api.models.list.mockResolvedValue([]);
  api.models.routing.mockResolvedValue({ auto: false, categories: [] });
  api.me.mockResolvedValue(null);
  api.voice.voices.mockResolvedValue([]);
  updateBot = vi.fn(async (_botId: string, patch: Partial<Bot>) => ({ ...BOT, ...patch }));
  refresh = vi.fn(async () => undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  store.reset();
});

let onView: ReturnType<typeof vi.fn<(view: BotPageView) => void>>;
let commands: BotCommands;

async function render(
  view: BotPageView,
  { bot = BOT, routines = [] as Routine[] | null, activityEpoch = 0 } = {},
) {
  onView = vi.fn<(view: BotPageView) => void>();
  commands = {
    updateBot: updateBot as BotCommands["updateBot"],
    setComputer: vi.fn(),
    botAction: vi.fn(),
    refresh,
    activityEpoch,
    openRun: vi.fn(),
    skillsChanged: vi.fn(),
  } as Partial<BotCommands> as BotCommands;
  await act(async () => {
    root.render(
      <SaveStoreProvider store={store}>
        <BotPage
          bot={bot}
          userId="user-1"
          routines={routines}
          memoryProviderConfigured={false}
          view={view}
          onView={onView}
          onClose={vi.fn()}
          commands={commands}
          messagingProviders={[]}
        />
      </SaveStoreProvider>,
    );
  });
}

function type(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const instructions = () =>
  container.querySelector<HTMLTextAreaElement>('[data-testid="bot-instructions"]')!;

it("saves edited instructions once when the field loses focus, trimmed", async () => {
  await render({ tab: "settings", detail: { kind: "instructions" } });

  act(() => instructions().focus());
  type(instructions(), "  Flag what needs a person, nothing else.  ");
  expect(updateBot).not.toHaveBeenCalled();
  await act(async () => instructions().blur());

  expect(updateBot.mock.calls).toEqual([
    ["bot-1", { instructions: "Flag what needs a person, nothing else." }],
  ]);
});

it("does not save instructions that left the field unchanged", async () => {
  await render({ tab: "settings", detail: { kind: "instructions" } });

  act(() => instructions().focus());
  type(instructions(), "Flag what needs a person.  ");
  await act(async () => instructions().blur());

  expect(updateBot).not.toHaveBeenCalled();
});

it("saves the notifications switch as soon as it changes", async () => {
  await render({ tab: "settings", detail: null });
  const toggle = container.querySelector<HTMLElement>('[aria-label="Notifications"]')!;

  await act(async () => toggle.click());

  expect(updateBot.mock.calls).toEqual([["bot-1", { notifyOnFinish: false }]]);
});

it("offers to write instructions under the bot's creation while it has none", async () => {
  api.bots.activity.mockResolvedValue({
    items: [
      {
        kind: "bot_created",
        botId: "bot-1",
        botName: "Scout",
        createdAt: "2026-10-01T08:00:00.000Z",
      },
    ],
    nextCursor: null,
  });
  const created = () => {
    const line = container.querySelector('[data-testid="activity-created"]');
    return [line?.querySelector("[dir]")?.textContent, line?.querySelector("button")?.textContent];
  };
  await render({ tab: "activity", detail: null }, { bot: { ...BOT, instructions: "" } });

  expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    "Activity",
    "Routines",
    "Knowledge",
    "Settings",
  ]);
  expect(created()).toEqual(["Scout created", "Write its first instructions"]);
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="activity-created"] button')!.click(),
  );
  expect(onView.mock.calls).toEqual([[{ tab: "activity", detail: { kind: "instructions" } }]]);

  await render({ tab: "activity", detail: null });
  expect(created()).toEqual(["Scout created", undefined]);
});

it("is busy until the bot's routines are read", async () => {
  await render({ tab: "settings", detail: null }, { routines: null });
  const page = () => container.querySelector('[data-testid="bot-page"]');
  expect(page()?.getAttribute("aria-busy")).toBe("true");

  await render({ tab: "settings", detail: null });
  expect(page()?.hasAttribute("aria-busy")).toBe(false);
});

it("says Could not load with Retry when a first read fails, and loads while Retry reads again", async () => {
  let answer!: () => void;
  refresh
    .mockRejectedValueOnce(new Error("offline"))
    .mockReturnValueOnce(new Promise<void>((done) => (answer = done)));
  await render({ tab: "routines", detail: null }, { routines: null });
  const panel = () => container.querySelector('[role="tabpanel"]')!;
  const page = () => container.querySelector('[data-testid="bot-page"]')!;
  expect(panel().textContent).toBe("Could not load · Retry");
  expect(page().hasAttribute("aria-busy")).toBe(false);

  await act(async () => panel().querySelector("button")!.click());

  expect(refresh.mock.calls).toEqual([["bot-1"], ["bot-1"]]);
  expect(panel().textContent).toBe("");
  expect(panel().querySelectorAll('[aria-busy="true"] > div')).toHaveLength(3);
  expect(page().getAttribute("aria-busy")).toBe("true");

  await act(async () => answer());
  expect(panel().textContent).toBe("");
});

it("says Could not load in place of a routine opened before the routines could be read", async () => {
  refresh.mockRejectedValueOnce(new Error("offline"));
  await render(
    { tab: "routines", detail: { kind: "routine", routineId: "r-1" } },
    { routines: null },
  );
  expect(container.querySelector('[data-testid="bot-page"]')?.textContent).toContain(
    "Could not load · Retry",
  );
  expect(onView).not.toHaveBeenCalled();
});

it("reads the bot again on each tab and when the window gains focus, never an archived one", async () => {
  await render({ tab: "settings", detail: null });
  await render({ tab: "routines", detail: null });
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(refresh.mock.calls).toEqual([["bot-1"], ["bot-1"], ["bot-1"]]);

  refresh.mockClear();
  await render(
    { tab: "activity", detail: null },
    { bot: { ...BOT, archivedAt: "2026-10-02T08:00:00.000Z" } as Bot },
  );
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(refresh).not.toHaveBeenCalled();
});

it("reads the bot again when one of its runs ends", async () => {
  await render({ tab: "routines", detail: null });
  expect(refresh.mock.calls).toEqual([["bot-1"]]);

  await render({ tab: "routines", detail: null }, { activityEpoch: 1 });
  expect(refresh.mock.calls).toEqual([["bot-1"], ["bot-1"]]);
});

it("fills a new routine from the latest skill picked, even when the form is already open", async () => {
  const nameField = () =>
    container.querySelector<HTMLInputElement>('[data-testid="routine-create"] input')!;
  await render({
    tab: "routines",
    detail: { kind: "routine-new", seed: { name: "Weekly wrap-up", prompt: "Sum up the week." } },
  });
  expect(nameField().value).toBe("Weekly wrap-up");

  await render({
    tab: "routines",
    detail: { kind: "routine-new", seed: { name: "Inbox triage", prompt: "Sort the inbox." } },
  });

  expect(nameField().value).toBe("Inbox triage");
  expect(
    container.querySelector<HTMLTextAreaElement>('[data-testid="routine-create"] textarea')?.value,
  ).toBe("Sort the inbox.");
});

it("shows an archived bot's page read-only, with Restore and Delete as its only actions", async () => {
  const archived = { ...BOT, archivedAt: "2026-10-02T08:00:00.000Z" } as Bot;
  api.bots.activity.mockResolvedValue({
    items: [
      {
        kind: "routine_run",
        run: {
          runId: "run-1",
          botId: "bot-1",
          groupId: null,
          routineId: "routine-1",
          routineName: "Inbox sweep",
          status: "completed",
          failureKind: null,
          sourceMessageId: "message-1",
          createdAt: "2026-10-01T09:00:00.000Z",
          updatedAt: "2026-10-01T09:01:00.000Z",
        },
      },
    ],
    nextCursor: null,
  });
  api.runs.recap.mockResolvedValue({ text: "Two emails need a reply.", messageId: "message-2" });
  await render(
    { tab: "settings", detail: { kind: "instructions" } },
    { bot: archived, routines: null },
  );

  const page = container.querySelector('[data-testid="bot-page"]')!;
  expect(page.hasAttribute("aria-busy")).toBe(false);
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.querySelector('[data-testid="bot-instructions"]')).toBeNull();
  expect(
    [...container.querySelectorAll<HTMLInputElement>("input")].map((input) => [
      input.value,
      input.disabled,
    ]),
  ).toEqual([
    ["Scout", true],
    ["Watches the inbox", true],
  ]);
  expect(
    container.querySelector<HTMLButtonElement>('[data-testid="bot-appearance-trigger"]')?.disabled,
  ).toBe(true);

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-testid="activity-run"]')!.click(),
  );
  const recap = container.querySelector('[data-testid="activity-recap"]')!;
  expect(recap.textContent).toBe("Two emails need a reply.");

  const more = container.querySelector<HTMLElement>('[aria-label="Actions for Scout"]')!;
  await act(async () => {
    more.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    more.click();
  });
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(items.map((item) => item.textContent)).toEqual(["Restore", "Delete"]);
  await act(async () => items[0]!.click());
  expect(vi.mocked(commands.botAction).mock.calls).toEqual([["bot-1", "restore"]]);
  expect(updateBot).not.toHaveBeenCalled();
});

async function renderKnowledge(view: BotPageView) {
  await render(view);
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

function clickOpener(opener: string) {
  return act(async () =>
    container.querySelector<HTMLButtonElement>(`[data-opens="${opener}"]`)!.click(),
  );
}

const saveButton = () =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")!;

it("edits a memory document in the wide detail, saved only by Save, then focuses its row", async () => {
  const doc = {
    id: "doc-1",
    path: "MEMORY.md",
    content: "Prefers short answers.",
    revision: 3,
    updatedAt: "2026-10-06T08:00:00.000Z",
  };
  api.memory.list.mockResolvedValue([doc]);
  api.memory.update.mockImplementation(async ({ content }: { content: string }) => ({
    ...doc,
    content,
    revision: 4,
  }));
  api.agentSkills.list.mockResolvedValue([]);
  api.computer.files.mockResolvedValue([]);
  api.scratchpad.list.mockResolvedValue([]);

  await renderKnowledge({ tab: "knowledge", detail: null });
  await clickOpener("memory:doc-1");
  expect(onView.mock.calls).toEqual([
    [{ tab: "knowledge", detail: { kind: "memory", documentId: "doc-1" } }],
  ]);

  await renderKnowledge({ tab: "knowledge", detail: { kind: "memory", documentId: "doc-1" } });
  const editor = container.querySelector("textarea")!;
  expect(editor.value).toBe("Prefers short answers.");
  type(editor, "Prefers short answers, in French.");
  await act(async () => editor.blur());
  expect(api.memory.update).not.toHaveBeenCalled();
  await act(async () => saveButton().click());
  expect(api.memory.update.mock.calls).toEqual([
    [{ documentId: "doc-1", content: "Prefers short answers, in French." }],
  ]);
  expect(onView.mock.calls).toEqual([[{ tab: "knowledge", detail: null }]]);

  await renderKnowledge({ tab: "knowledge", detail: null });
  expect(document.activeElement?.getAttribute("data-opens")).toBe("memory:doc-1");
});

it("edits a skill in the wide detail, tells the shell once saved, then focuses its row", async () => {
  const skill = {
    id: "skill-1",
    name: "inbox-triage",
    description: "Sorts a mailbox.",
    content: "---\nname: inbox-triage\ndescription: Sorts a mailbox.\n---\n\nSort it.",
    source: "user",
    readOnly: false,
    availability: "all",
    visibleBotIds: ["bot-1"],
  };
  api.memory.list.mockResolvedValue([]);
  api.agentSkills.list.mockResolvedValue([skill]);
  api.agentSkills.get.mockResolvedValue(skill);
  api.agentSkills.update.mockResolvedValue(skill);
  api.computer.files.mockResolvedValue([]);
  api.scratchpad.list.mockResolvedValue([]);

  await renderKnowledge({ tab: "knowledge", detail: null });
  await clickOpener("skill:skill-1");
  expect(onView.mock.calls).toEqual([
    [{ tab: "knowledge", detail: { kind: "skill", skillId: "skill-1" } }],
  ]);

  await renderKnowledge({ tab: "knowledge", detail: { kind: "skill", skillId: "skill-1" } });
  const editor = container.querySelector("textarea")!;
  type(editor, `${skill.content} Then reply.`);
  await act(async () => saveButton().click());
  expect(api.agentSkills.update.mock.calls).toEqual([
    [{ skillId: "skill-1", content: `${skill.content} Then reply.` }],
  ]);
  expect(vi.mocked(commands.skillsChanged).mock.calls).toEqual([[]]);
  expect(onView.mock.calls).toEqual([[{ tab: "knowledge", detail: null }]]);

  await renderKnowledge({ tab: "knowledge", detail: null });
  expect(document.activeElement?.getAttribute("data-opens")).toBe("skill:skill-1");
});

it("keeps a memory document's row on screen while the list reads again after its editor closes", async () => {
  const doc = {
    id: "doc-1",
    path: "MEMORY.md",
    content: "Prefers short answers.",
    revision: 3,
    updatedAt: "2026-10-06T08:00:00.000Z",
  };
  api.memory.list.mockResolvedValue([doc]);
  api.memory.update.mockResolvedValue({ ...doc, content: "Prefers French.", revision: 4 });
  api.agentSkills.list.mockResolvedValue([]);
  api.computer.files.mockResolvedValue([]);
  api.scratchpad.list.mockResolvedValue([]);

  await renderKnowledge({ tab: "knowledge", detail: null });
  await renderKnowledge({ tab: "knowledge", detail: { kind: "memory", documentId: "doc-1" } });
  type(container.querySelector("textarea")!, "Prefers French.");
  let reread: (docs: (typeof doc)[]) => void = () => {};
  api.memory.list.mockReturnValue(new Promise((resolve) => (reread = resolve)));
  await act(async () => saveButton().click());

  await renderKnowledge({ tab: "knowledge", detail: null });
  const memory = () => container.querySelector('[data-testid="bot-knowledge-memory"]')!.textContent;
  expect(memory()).toBe("MEMORY.mdrev 3Download as markdown");

  await act(async () => reread([{ ...doc, revision: 4 }]));
  expect(memory()).toBe("MEMORY.mdrev 4Download as markdown");
});

it("deletes a skill in the wide detail, tells the shell once, and leaves focus alone", async () => {
  const skill = {
    id: "skill-1",
    name: "inbox-triage",
    description: "Sorts a mailbox.",
    content: "---\nname: inbox-triage\ndescription: Sorts a mailbox.\n---\n\nSort it.",
    source: "user",
    readOnly: false,
    availability: "all",
    visibleBotIds: ["bot-1"],
  };
  api.memory.list.mockResolvedValue([]);
  api.agentSkills.list.mockResolvedValue([skill]);
  api.agentSkills.get.mockResolvedValue(skill);
  api.agentSkills.remove.mockResolvedValue(undefined);
  api.computer.files.mockResolvedValue([]);
  api.scratchpad.list.mockResolvedValue([]);

  await renderKnowledge({ tab: "knowledge", detail: null });
  await renderKnowledge({ tab: "knowledge", detail: { kind: "skill", skillId: "skill-1" } });
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
  await act(async () => button("Delete").click());
  api.agentSkills.list.mockResolvedValue([]);
  await act(async () => button("Confirm delete").click());
  expect(api.agentSkills.remove.mock.calls).toEqual([[{ skillId: "skill-1" }]]);
  expect(vi.mocked(commands.skillsChanged).mock.calls).toEqual([[]]);
  expect(onView.mock.calls).toEqual([[{ tab: "knowledge", detail: null }]]);

  await renderKnowledge({ tab: "knowledge", detail: null });
  const skills = container.querySelector('[data-testid="bot-knowledge-skills"]')!;
  expect(skills.querySelector('[data-opens="skill:skill-1"]')).toBeNull();
  expect(skills.textContent).toContain("No skills yet");
  expect(document.activeElement).toBe(document.body);
});

it("marks the Activity tab while a routine that is on last failed, until it succeeds, pauses or goes", async () => {
  const routine = (lastRunStatus: Routine["lastRunStatus"], active = true) =>
    ({ id: "routine-1", name: "Inbox sweep", active, lastRunStatus }) as Routine;
  const other = {
    id: "routine-2",
    name: "Digest",
    active: true,
    lastRunStatus: "succeeded",
  } as Routine;
  const activityTab = () => {
    const tab = container.querySelector('[data-testid="bot-tab-activity"]');
    return [tab?.getAttribute("aria-label") ?? null, tab?.querySelectorAll("[aria-hidden]").length];
  };

  await render({ tab: "activity", detail: null }, { routines: [routine("failed")] });
  expect(activityTab()).toEqual(["Activity, last run failed", 1]);

  await render({ tab: "activity", detail: null }, { routines: [routine("succeeded")] });
  expect(activityTab()).toEqual([null, 0]);

  await render({ tab: "activity", detail: null }, { routines: [routine("failed", false)] });
  expect(activityTab()).toEqual([null, 0]);

  await render({ tab: "activity", detail: null }, { routines: [other, routine("failed")] });
  expect(activityTab()).toEqual(["Activity, last run failed", 1]);

  await render({ tab: "activity", detail: null }, { routines: [other] });
  expect(activityTab()).toEqual([null, 0]);
});
