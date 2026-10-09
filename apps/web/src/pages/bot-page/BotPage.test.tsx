// @vitest-environment jsdom
import type { Bot, Routine } from "@rakazo/contracts";
import { createSaveStore } from "@rakazo/core";
import { SaveStoreProvider } from "@rakazo/ui-web";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotCommands } from "../shell/bot-commands";
import type { BotPageView } from "../shell/layout";

const api = vi.hoisted(() => ({
  models: { credentials: vi.fn(), list: vi.fn() },
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
} as unknown as Bot;

const store = createSaveStore();
let container: HTMLElement;
let root: Root;
let updateBot: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: false,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  api.models.credentials.mockResolvedValue([]);
  api.models.list.mockResolvedValue([]);
  api.me.mockResolvedValue(null);
  api.voice.voices.mockResolvedValue([]);
  updateBot = vi.fn(async (_botId: string, patch: Partial<Bot>) => ({ ...BOT, ...patch }));
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

async function render(
  view: BotPageView,
  { bot = BOT, routines = [] as Routine[], neverRan = false as boolean | null } = {},
) {
  const commands: BotCommands = {
    updateBot: updateBot as BotCommands["updateBot"],
    setComputer: vi.fn(),
    botAction: vi.fn(),
  };
  await act(async () => {
    root.render(
      <SaveStoreProvider store={store}>
        <BotPage
          bot={bot}
          userId="user-1"
          routines={routines}
          runningRoutineId={null}
          neverRan={neverRan}
          memoryProviderConfigured={false}
          view={view}
          onView={vi.fn()}
          onClose={vi.fn()}
          onOpenRoutine={vi.fn()}
          onStopRun={vi.fn()}
          commands={commands}
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

it("shows the first-bot state only for a bot with no instructions, routines or runs", async () => {
  const fresh = { ...BOT, instructions: "" };
  const tabs = () => container.querySelector('[role="tablist"]');

  await render({ tab: "settings", detail: null }, { bot: fresh, neverRan: true });
  expect(container.textContent).toContain("Not awake yet");
  expect(tabs()).toBeNull();

  await render({ tab: "settings", detail: null }, { bot: fresh, neverRan: false });
  expect(container.textContent).not.toContain("Not awake yet");
  expect(tabs()).not.toBeNull();

  await render(
    { tab: "settings", detail: null },
    { bot: fresh, neverRan: true, routines: [{ id: "routine-1" } as Routine] },
  );
  expect(tabs()).not.toBeNull();

  await render({ tab: "settings", detail: null }, { bot: BOT, neverRan: true });
  expect(tabs()).not.toBeNull();
});

it("is busy, and shows no first-bot state, until the conversation is read", async () => {
  await render(
    { tab: "settings", detail: null },
    { bot: { ...BOT, instructions: "" }, neverRan: null },
  );
  const page = container.querySelector('[data-testid="bot-page"]');
  expect(page?.getAttribute("aria-busy")).toBe("true");
  expect(container.textContent).not.toContain("Not awake yet");
});
