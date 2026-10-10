// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { Bot, Routine } from "@rakazo/contracts";
import { SaveStoreProvider } from "@rakazo/ui-web";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveStore } from "../../lib/save-store";
import type { BotCommands } from "../shell/bot-commands";

vi.mock("../../lib/rpc", () => ({ rpc: {} }));
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

import type { BotPageContext } from "./page-kit";
import { RoutineCreateForm } from "./RoutineCreateForm";
import { RoutineDetail } from "./RoutineDetail";
import { RoutinesTab } from "./RoutinesTab";

const BOT = { id: "bot-1", spaceId: "space-1", name: "Scout", webhookConfigured: false } as Bot;

const ROUTINE: Routine = {
  id: "routine-1",
  botId: "bot-1",
  name: "Morning digest",
  prompt: "Sum up the inbox.",
  crons: ["0 9 * * 1-5"],
  timezone: "Europe/Paris",
  active: false,
  notify: false,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  requireToolApproval: true,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunFailureKind: null,
  nextRunAt: null,
  createdAt: "2026-10-01T08:00:00.000Z",
};

let container: HTMLElement;
let root: Root;

function page(commands: Partial<BotCommands>, bot: Bot = BOT): BotPageContext {
  return { bot, userId: "user-1", commands: commands as BotCommands };
}

function deferred<T>() {
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_, fail) => {
    reject = fail;
  });
  return { promise, reject };
}

async function render(node: ReactNode) {
  await act(async () =>
    root.render(<SaveStoreProvider store={saveStore}>{node}</SaveStoreProvider>),
  );
}

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
  saveStore.reset();
});

it("saves a routine's switch at once, then turns it back and says why when the save fails", async () => {
  const write = deferred<Routine>();
  const updateRoutine = vi.fn(() => write.promise);
  await render(
    <RoutinesTab page={page({ updateRoutine })} routines={[ROUTINE]} onOpen={vi.fn()} />,
  );
  const toggle = container.querySelector<HTMLElement>('[aria-label="Active: Morning digest"]')!;
  expect(toggle.getAttribute("aria-checked")).toBe("false");

  await act(async () => toggle.click());

  expect(updateRoutine.mock.calls).toEqual([["bot-1", "routine-1", { active: true }]]);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("Saving…");

  await act(async () =>
    write.reject(new ORPCError("BAD_REQUEST", { message: "Add a run time for this one-shot." })),
  );

  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).toContain("Add a run time for this one-shot. · Retry");
});

it("shows why a routine cannot be created yet instead of creating it", async () => {
  const createRoutine = vi.fn();
  await render(
    <RoutineCreateForm
      page={page({ createRoutine })}
      seed={{ name: "Weekly wrap-up", prompt: "Sum up the week." }}
      messageProviders={[]}
      webhookSecret={null}
      onWebhookSecret={vi.fn()}
      confirm={vi.fn()}
      onCreated={vi.fn()}
    />,
  );
  const create = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Create",
  )!;

  await act(async () => create.click());

  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Add a schedule, webhook, GitHub, or message trigger",
  );
  expect(createRoutine).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Weekly wrap-up");
});

it("words a weekly routine and opens a new one from the round add button", async () => {
  const onOpen = vi.fn();
  await render(
    <RoutinesTab
      page={page({})}
      routines={[{ ...ROUTINE, crons: ["0 10 * * 6"] }]}
      onOpen={onOpen}
    />,
  );
  expect(container.textContent).toContain("Weekly on Saturday at 10:00 AM · paused");

  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="New routine"]')?.click(),
  );
  expect(onOpen.mock.calls).toEqual([[{ kind: "routine-new" }]]);
});

it("says when and why an active routine's last run failed, with a red dot", async () => {
  await render(
    <RoutinesTab
      page={page({})}
      routines={[
        {
          ...ROUTINE,
          active: true,
          lastRunAt: new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString(),
          lastRunStatus: "failed",
          lastRunFailureKind: "provider",
        },
      ]}
      onOpen={vi.fn()}
    />,
  );
  expect(container.textContent).toContain(
    "Last run failedMorning digestFailed yesterday · Model error",
  );
  expect(container.querySelector(".bg-destructive")).not.toBeNull();
});

function button(name: string) {
  return [...document.querySelectorAll("button")].find((item) => item.textContent === name)!;
}

async function openTrigger(routine: Routine, row: string, confirm = vi.fn()) {
  const updateRoutine = vi.fn(async () => routine);
  await render(
    <RoutineDetail
      page={page({ updateRoutine, revealWebhookSecret: async () => "key-minted-once" })}
      routine={routine}
      messageProviders={[]}
      webhookSecret={null}
      onWebhookSecret={vi.fn()}
      confirm={confirm}
      onDeleted={vi.fn()}
    />,
  );
  const opener = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.startsWith(row),
  )!;
  await act(async () => opener.click());
  return updateRoutine;
}

it("asks before removing an inbound trigger, then saves only that trigger", async () => {
  const confirm = vi.fn(async () => true);
  const updateRoutine = await openTrigger(
    { ...ROUTINE, webhookEnabled: true },
    "When a webhook fires",
    confirm,
  );

  await act(async () => button("Remove").click());

  expect(confirm.mock.calls).toEqual([["Remove webhook?", "Remove"]]);
  expect(updateRoutine.mock.calls).toEqual([["bot-1", "routine-1", { webhookEnabled: false }]]);
});

it("refuses to remove a routine's last trigger", async () => {
  const updateRoutine = await openTrigger(ROUTINE, "On a schedule");

  await act(async () => button("Remove").click());

  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
    "Add a schedule, webhook, GitHub, or message trigger",
  );
  expect(updateRoutine).not.toHaveBeenCalled();
});

/** Holds the page's key and, like the shell, marks the bot keyed once the server answers. */
function KeyHolder({
  bot,
  commands,
  children,
}: {
  bot: Bot;
  commands: Partial<BotCommands>;
  children: (
    page: BotPageContext,
    secret: string | null,
    onSecret: (secret: string) => void,
  ) => ReactNode;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  const [keyed, setKeyed] = useState(bot.webhookConfigured);
  const reveal = commands.revealWebhookSecret;
  const shell = reveal
    ? {
        ...commands,
        revealWebhookSecret: async (...args: Parameters<typeof reveal>) => {
          const minted = await reveal(...args);
          setKeyed(true);
          return minted;
        },
      }
    : commands;
  return children(page(shell, { ...bot, webhookConfigured: keyed }), secret, setSecret);
}

async function pickWebhook(name = "Webhook") {
  await act(async () => button("Add trigger").click());
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent === name,
  ) as HTMLElement;
  await act(async () => item.click());
}

const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";

const WEBHOOK_URL = `${window.location.origin}/api/v1/bots/bot-1/webhook`;

function newRoutineForm(
  commands: Partial<BotCommands>,
  onCreated = vi.fn(),
  bot: Bot = BOT,
  seed = { name: "Deploy watch", prompt: "Say what shipped." },
) {
  return (
    <KeyHolder bot={bot} commands={commands}>
      {(context, secret, onSecret) => (
        <RoutineCreateForm
          page={context}
          seed={seed}
          messageProviders={[]}
          webhookSecret={secret}
          onWebhookSecret={onSecret}
          confirm={vi.fn()}
          onCreated={onCreated}
        />
      )}
    </KeyHolder>
  );
}

function savedRoutine(commands: Partial<BotCommands>, bot: Bot = BOT) {
  return (
    <KeyHolder bot={bot} commands={commands}>
      {(context, secret, onSecret) => (
        <RoutineDetail
          page={context}
          routine={ROUTINE}
          messageProviders={[]}
          webhookSecret={secret}
          onWebhookSecret={onSecret}
          confirm={vi.fn()}
          onDeleted={vi.fn()}
        />
      )}
    </KeyHolder>
  );
}

it("shows a new routine's webhook address and a freshly minted key as soon as it is picked", async () => {
  const created = { ...ROUTINE, id: "routine-2", webhookEnabled: true, crons: [] };
  const createRoutine = vi.fn(async () => created);
  const revealWebhookSecret = vi.fn(async () => "key-minted-once");
  const onCreated = vi.fn();
  await render(newRoutineForm({ createRoutine, revealWebhookSecret }, onCreated));

  await pickWebhook();

  expect(dialogText()).toContain(WEBHOOK_URL);
  expect(dialogText()).toContain("key-minted-once");
  expect(dialogText()).toContain("Authorization: Bearer key-minted-once");
  expect(dialogText()).toContain("Shown once.");
  expect(dialogText()).not.toContain("Available after the routine is saved");
  expect(revealWebhookSecret).toHaveBeenCalledTimes(1);

  await act(async () => button("Done").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button("Create").click());

  expect(createRoutine.mock.calls).toMatchObject([["bot-1", { webhookEnabled: true }]]);
  expect(onCreated.mock.calls).toEqual([[created]]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(revealWebhookSecret).toHaveBeenCalledTimes(1);
});

it("adds a new routine's webhook on Done even when the key could not be minted", async () => {
  const revealWebhookSecret = vi.fn(async () => {
    throw new Error("The server did not answer.");
  });
  await render(newRoutineForm({ revealWebhookSecret }));

  await pickWebhook();

  expect(dialogText()).toContain(WEBHOOK_URL);
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
    "The server did not answer.",
  );
  await act(async () => button("Done").click());

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(
    [...container.querySelectorAll("button")].some((item) =>
      item.textContent?.startsWith("When a webhook fires"),
    ),
  ).toBe(true);
});

it("shows a saved routine's first webhook key as soon as it is picked, and Done saves it", async () => {
  const updateRoutine = vi.fn(async () => ({ ...ROUTINE, webhookEnabled: true }));
  const revealWebhookSecret = vi.fn(async () => "key-minted-once");
  await render(savedRoutine({ updateRoutine, revealWebhookSecret }));

  await pickWebhook();

  expect(dialogText()).toContain(WEBHOOK_URL);
  expect(dialogText()).toContain("Authorization: Bearer key-minted-once");
  expect(updateRoutine).not.toHaveBeenCalled();

  await act(async () => button("Done").click());

  expect(updateRoutine.mock.calls).toEqual([["bot-1", "routine-1", { webhookEnabled: true }]]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(revealWebhookSecret).toHaveBeenCalledTimes(1);
});

it("keeps a bot's existing key hidden until it is rotated", async () => {
  const revealWebhookSecret = vi.fn(async () => "key-after-rotation");
  const keyed = { ...BOT, webhookConfigured: true } as Bot;
  await render(savedRoutine({ revealWebhookSecret }, keyed));

  await pickWebhook();

  expect(dialogText()).toContain("Saved. Rotate to reveal.");
  expect(dialogText()).toContain("Authorization: Bearer …");
  expect(dialogText()).not.toContain("Shown once.");
  expect(revealWebhookSecret).not.toHaveBeenCalled();

  await act(async () => button("Rotate key").click());

  expect(dialogText()).toContain("Authorization: Bearer key-after-rotation");
  expect(dialogText()).toContain("Shown once.");
  expect(revealWebhookSecret.mock.calls).toEqual([["bot-1"]]);
});

it("keeps the bot's live key when the server already holds one this page did not know about", async () => {
  const revealWebhookSecret = vi.fn(async () => null);
  await render(savedRoutine({ revealWebhookSecret }));

  await pickWebhook();

  expect(revealWebhookSecret.mock.calls).toEqual([["bot-1", { ifAbsent: true }]]);
  expect(dialogText()).toContain("Saved. Rotate to reveal.");
  expect(dialogText()).toContain("Authorization: Bearer …");
  expect(dialogText()).not.toContain("Shown once.");
});

it("mints a key only when absent as a Git event opens, and Cancel adds no trigger", async () => {
  const createRoutine = vi.fn();
  const revealWebhookSecret = vi.fn(async () => "key-minted-once");
  await render(newRoutineForm({ createRoutine, revealWebhookSecret }));

  await pickWebhook("Git event");

  expect(revealWebhookSecret.mock.calls).toEqual([["bot-1", { ifAbsent: true }]]);
  expect(dialogText()).toContain(`${window.location.origin}/api/v1/bots/bot-1/github`);
  expect(dialogText()).toContain("key-minted-once");

  await act(async () => button("Cancel").click());

  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(
    [...container.querySelectorAll("button")].some((item) =>
      item.textContent?.startsWith("Git event"),
    ),
  ).toBe(false);
  expect(createRoutine).not.toHaveBeenCalled();
});

it("offers no key rotation on a routine that is not saved yet", async () => {
  const revealWebhookSecret = vi.fn(async () => "key-after-rotation");
  await render(
    newRoutineForm({ revealWebhookSecret }, vi.fn(), { ...BOT, webhookConfigured: true }),
  );

  await pickWebhook();

  expect(dialogText()).toContain("Saved. Rotate to reveal.");
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("Rotate key");
  expect(revealWebhookSecret).not.toHaveBeenCalled();
});
