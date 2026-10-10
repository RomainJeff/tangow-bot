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

function page(commands: Partial<BotCommands>): BotPageContext {
  return { bot: BOT, userId: "user-1", commands: commands as BotCommands };
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
      page={page({ updateRoutine })}
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

function KeyHolder({
  children,
}: {
  children: (secret: string | null, onSecret: (secret: string) => void) => ReactNode;
}) {
  const [secret, setSecret] = useState<string | null>(null);
  return children(secret, setSecret);
}

async function addWebhook() {
  await act(async () => button("Add trigger").click());
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent === "Webhook",
  ) as HTMLElement;
  await act(async () => item.click());
  await act(async () => button("Done").click());
}

const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";

it("shows the bot's key once a routine's first webhook mints it, until Done", async () => {
  const updateRoutine = vi.fn(async () => ({ ...ROUTINE, webhookEnabled: true }));
  const revealWebhookSecret = vi.fn(async () => "key-minted-once");
  await render(
    <KeyHolder>
      {(secret, onSecret) => (
        <RoutineDetail
          page={page({ updateRoutine, revealWebhookSecret })}
          routine={ROUTINE}
          messageProviders={[]}
          webhookSecret={secret}
          onWebhookSecret={onSecret}
          confirm={vi.fn()}
          onDeleted={vi.fn()}
        />
      )}
    </KeyHolder>,
  );

  await addWebhook();

  expect(updateRoutine.mock.calls).toEqual([["bot-1", "routine-1", { webhookEnabled: true }]]);
  expect(dialogText()).toContain("key-minted-once");
  expect(dialogText()).toContain("Authorization: Bearer key-minted-once");

  await act(async () => button("Done").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("shows the key a new routine's webhook minted before opening the routine", async () => {
  const created = { ...ROUTINE, id: "routine-2", webhookEnabled: true, crons: [] };
  const createRoutine = vi.fn(async () => created);
  const revealWebhookSecret = vi.fn(async () => "key-minted-once");
  const onCreated = vi.fn();
  await render(
    <KeyHolder>
      {(secret, onSecret) => (
        <RoutineCreateForm
          page={page({ createRoutine, revealWebhookSecret })}
          seed={{ name: "Deploy watch", prompt: "Say what shipped." }}
          messageProviders={[]}
          webhookSecret={secret}
          onWebhookSecret={onSecret}
          confirm={vi.fn()}
          onCreated={onCreated}
        />
      )}
    </KeyHolder>,
  );
  await addWebhook();

  await act(async () => button("Create").click());

  expect(dialogText()).toContain("Authorization: Bearer key-minted-once");
  expect(onCreated).not.toHaveBeenCalled();
  await act(async () => button("Done").click());
  expect(onCreated.mock.calls).toEqual([[created]]);
});
