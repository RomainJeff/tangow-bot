// @vitest-environment jsdom
import { ORPCError } from "@orpc/client";
import type { Bot, BotActivityOutput, Routine } from "@rakazo/contracts";
import { SaveStoreProvider } from "@rakazo/ui-web";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { saveStore } from "../../lib/save-store";
import type { BotCommands } from "../shell/bot-commands";

const api = vi.hoisted(() => ({ bots: { activity: vi.fn() } }));
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
  api.bots.activity.mockResolvedValue({ items: [], nextCursor: null });
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

it("lists the routine's own runs on its page, and a test run as soon as it starts", async () => {
  const run = (runId: string, status: "completed" | "failed" | "running", createdAt: string) => ({
    kind: "routine_run" as const,
    run: {
      runId,
      botId: "bot-1",
      botName: "Scout",
      groupId: null,
      groupName: null,
      threadId: "thread-1",
      status,
      trigger: "routine" as const,
      notificationsEnabled: false,
      promptSnippet: "",
      createdAt,
      updatedAt: createdAt,
      routineId: "routine-1",
      routineName: "Morning digest",
      sourceMessageId: null,
      startedAt: createdAt,
      completedAt: status === "running" ? null : createdAt,
      failureKind: status === "failed" ? ("missing_model" as const) : null,
    },
  });
  api.bots.activity.mockResolvedValue({
    items: [
      run("run-2", "failed", "2026-10-06T09:00:00.000Z"),
      run("run-1", "completed", "2026-10-06T08:00:00.000Z"),
    ],
    nextCursor: null,
  } satisfies BotActivityOutput);
  const testRun = vi.fn(async () => {});
  await render(
    <RoutineDetail
      page={page({ activityEpoch: 0, openRun: vi.fn(), testRun })}
      routine={ROUTINE}
      messageProviders={[]}
      confirm={vi.fn()}
      onDeleted={vi.fn()}
    />,
  );

  const lines = () =>
    [...container.querySelectorAll('[data-testid="activity-run"]')].map((line) =>
      line.getAttribute("aria-label"),
    );
  expect(api.bots.activity.mock.calls).toEqual([[{ botId: "bot-1", routineId: "routine-1" }]]);
  expect(lines()).toEqual([
    // On its own page a routine's lines lead with their time, not its name.
    expect.stringMatching(/^\d{1,2}:\d{2}\s?[AP]M, No model connected, Failed$/),
    expect.stringMatching(/^\d{1,2}:\d{2}\s?[AP]M, Done$/),
  ]);

  api.bots.activity.mockResolvedValue({
    items: [
      run("run-3", "running", "2026-10-06T10:00:00.000Z"),
      run("run-2", "failed", "2026-10-06T09:00:00.000Z"),
      run("run-1", "completed", "2026-10-06T08:00:00.000Z"),
    ],
    nextCursor: null,
  } satisfies BotActivityOutput);
  await act(async () => button("Test run").click());

  expect(testRun.mock.calls).toEqual([["bot-1", "routine-1"]]);
  expect(lines()[0]).toMatch(/^\d{1,2}:\d{2}\s?[AP]M, Running$/);
});

function button(name: string) {
  return [...document.querySelectorAll("button")].find((item) => item.textContent === name)!;
}

async function openTrigger(routine: Routine, row: string, confirm = vi.fn()) {
  const updateRoutine = vi.fn(async () => routine);
  await render(
    <RoutineDetail
      page={page({ updateRoutine, webhookSecret: async () => "live-key" })}
      routine={routine}
      messageProviders={[]}
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

/** Like the shell, marks the bot keyed once the server has answered a read of its key. */
function KeyHolder({
  bot,
  commands,
  children,
}: {
  bot: Bot;
  commands: Partial<BotCommands>;
  children: (page: BotPageContext) => ReactNode;
}) {
  const [keyed, setKeyed] = useState(bot.webhookConfigured);
  const read = commands.webhookSecret;
  const shell = read
    ? {
        ...commands,
        webhookSecret: async (botId: string) => {
          const secret = await read(botId);
          setKeyed(true);
          return secret;
        },
      }
    : commands;
  return children(page(shell, { ...bot, webhookConfigured: keyed }));
}

async function pickWebhook(name = "Webhook") {
  await act(async () => button("Add trigger").click());
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (entry) => entry.textContent === name,
  ) as HTMLElement;
  await act(async () => item.click());
}

const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";

const labelled = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${name}"]`);

const WEBHOOK_URL = `${window.location.origin}/api/v1/bots/bot-1/webhook`;

const DOTS = "••••••••••••••••";

function newRoutineForm(
  commands: Partial<BotCommands>,
  onCreated = vi.fn(),
  bot: Bot = BOT,
  seed = { name: "Deploy watch", prompt: "Say what shipped." },
) {
  return (
    <KeyHolder bot={bot} commands={commands}>
      {(context) => (
        <RoutineCreateForm
          page={context}
          seed={seed}
          messageProviders={[]}
          confirm={vi.fn()}
          onCreated={onCreated}
        />
      )}
    </KeyHolder>
  );
}

function savedRoutine(commands: Partial<BotCommands>, bot: Bot = BOT, confirm = vi.fn()) {
  return (
    <KeyHolder bot={bot} commands={commands}>
      {(context) => (
        <RoutineDetail
          page={context}
          routine={ROUTINE}
          messageProviders={[]}
          confirm={confirm}
          onDeleted={vi.fn()}
        />
      )}
    </KeyHolder>
  );
}

it("shows a new routine's webhook address and its key behind dots as soon as it is picked", async () => {
  const created = { ...ROUTINE, id: "routine-2", webhookEnabled: true, crons: [] };
  const createRoutine = vi.fn(async () => created);
  const webhookSecret = vi.fn(async () => "live-key");
  const onCreated = vi.fn();
  await render(newRoutineForm({ createRoutine, webhookSecret }, onCreated));

  await pickWebhook();

  expect(dialogText()).toContain(WEBHOOK_URL);
  expect(dialogText()).toContain(`key${DOTS}`);
  expect(dialogText()).toContain(`Authorization: Bearer ${DOTS}`);
  expect(dialogText()).not.toContain("live-key");
  expect(webhookSecret.mock.calls).toEqual([["bot-1"]]);

  await act(async () => button("Done").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button("Create").click());

  expect(createRoutine.mock.calls).toMatchObject([["bot-1", { webhookEnabled: true }]]);
  expect(onCreated.mock.calls).toEqual([[created]]);
  expect(webhookSecret).toHaveBeenCalledTimes(1);
});

it("shows the key when the eye is pressed and hides it again", async () => {
  await render(newRoutineForm({ webhookSecret: async () => "live-key" }));
  await pickWebhook();

  await act(async () => labelled("Show key")!.click());

  expect(dialogText()).toContain("Authorization: Bearer live-key");
  expect(labelled("Hide key")?.getAttribute("aria-pressed")).toBe("true");

  await act(async () => labelled("Hide key")!.click());

  expect(dialogText()).not.toContain("live-key");
  expect(dialogText()).toContain(`Authorization: Bearer ${DOTS}`);
});

it("copies the real key and header while they are hidden", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  await render(newRoutineForm({ webhookSecret: async () => "live-key" }));
  await pickWebhook();

  await act(async () => labelled("Copy key")!.click());
  await act(async () => labelled("Copy header")!.click());
  await act(async () => labelled("Copy POST to")!.click());

  expect(writeText.mock.calls).toEqual([
    ["live-key"],
    ["Authorization: Bearer live-key"],
    [WEBHOOK_URL],
  ]);
  expect(dialogText()).not.toContain("live-key");
});

it("adds a new routine's webhook on Done even when the key could not be read", async () => {
  const webhookSecret = vi.fn(async (): Promise<string> => {
    throw new Error("The server did not answer.");
  });
  await render(newRoutineForm({ webhookSecret }));

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

it("shows a saved routine's webhook key as soon as it is picked, and Done saves the trigger", async () => {
  const updateRoutine = vi.fn(async () => ({ ...ROUTINE, webhookEnabled: true }));
  const webhookSecret = vi.fn(async () => "live-key");
  await render(savedRoutine({ updateRoutine, webhookSecret }));

  await pickWebhook();

  expect(dialogText()).toContain(WEBHOOK_URL);
  expect(dialogText()).toContain(`Authorization: Bearer ${DOTS}`);
  expect(updateRoutine).not.toHaveBeenCalled();

  await act(async () => button("Done").click());

  expect(updateRoutine.mock.calls).toEqual([["bot-1", "routine-1", { webhookEnabled: true }]]);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(webhookSecret).toHaveBeenCalledTimes(1);
});

it("rotates a saved routine's key only once confirmed, then shows the new key hidden", async () => {
  const rotateWebhookSecret = vi.fn(async () => "rotated-key");
  const confirm = vi.fn(async () => false);
  const keyed = { ...BOT, webhookConfigured: true } as Bot;
  await render(
    savedRoutine({ webhookSecret: async () => "live-key", rotateWebhookSecret }, keyed, confirm),
  );
  await pickWebhook();

  await act(async () => button("Rotate key").click());

  expect(confirm.mock.calls).toEqual([["Rotate key?", "Rotate"]]);
  expect(rotateWebhookSecret).not.toHaveBeenCalled();

  confirm.mockResolvedValue(true);
  await act(async () => button("Rotate key").click());
  await act(async () => labelled("Show key")!.click());

  expect(rotateWebhookSecret.mock.calls).toEqual([["bot-1"]]);
  expect(dialogText()).toContain("Authorization: Bearer rotated-key");
  expect(dialogText()).not.toContain("live-key");
});

it("reads the key as a Git event opens, and Cancel adds no trigger", async () => {
  const createRoutine = vi.fn();
  const webhookSecret = vi.fn(async () => "live-key");
  await render(newRoutineForm({ createRoutine, webhookSecret }));

  await pickWebhook("Git event");

  expect(webhookSecret.mock.calls).toEqual([["bot-1"]]);
  expect(dialogText()).toContain(`${window.location.origin}/api/v1/bots/bot-1/github`);
  expect(dialogText()).toContain(`key${DOTS}`);
  expect(dialogText()).toContain("X-Hub-Signature-256: sha256=…");

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
  const rotateWebhookSecret = vi.fn(async () => "rotated-key");
  await render(
    newRoutineForm({ webhookSecret: async () => "live-key", rotateWebhookSecret }, vi.fn(), {
      ...BOT,
      webhookConfigured: true,
    } as Bot),
  );

  await pickWebhook();

  expect(dialogText()).toContain(`key${DOTS}`);
  expect(dialogText()).not.toContain("Rotate key");
});
