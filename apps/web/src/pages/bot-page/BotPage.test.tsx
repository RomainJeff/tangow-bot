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

async function render(view: BotPageView, { bot = BOT, routines = [] as Routine[] | null } = {}) {
  const commands = {
    updateBot: updateBot as BotCommands["updateBot"],
    setComputer: vi.fn(),
    botAction: vi.fn(),
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
          onView={vi.fn()}
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

it("opens a new bot on its tabs, like any bot", async () => {
  await render({ tab: "settings", detail: null }, { bot: { ...BOT, instructions: "" } });

  const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
  expect(tabs).toEqual(["Routines", "Knowledge", "Settings"]);
});

it("is busy until the bot's routines are read", async () => {
  await render({ tab: "settings", detail: null }, { routines: null });
  const page = () => container.querySelector('[data-testid="bot-page"]');
  expect(page()?.getAttribute("aria-busy")).toBe("true");

  await render({ tab: "settings", detail: null });
  expect(page()?.hasAttribute("aria-busy")).toBe(false);
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
