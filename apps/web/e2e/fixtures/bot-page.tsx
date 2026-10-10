import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { ORPCError } from "@orpc/client";
import type { Bot, Routine } from "@rakazo/contracts";
import { SaveStoreProvider } from "@rakazo/ui-web";
import { useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { saveStore as store } from "../../src/lib/save-store";
import { applyResolvedAppearance } from "../../src/lib/ui-appearance";
import { BotPage } from "../../src/pages/bot-page/BotPage";
import type { BotCommands, UpdateBotPatch } from "../../src/pages/shell/bot-commands";
import type { BotDetail, BotPageView, BotTab } from "../../src/pages/shell/layout";
import { panelSizeFor } from "../../src/pages/shell/layout";
import { usePanelEscape } from "../../src/pages/shell/panel-escape";
import "../../src/styles.css";

/*
 * The bot page without a server. Query parameters pick what it shows:
 *   tab=routines|knowledge|settings
 *   detail=instructions|description|model|voice|routine|routine-new   routine=<id>
 *   busy=1 (the bot is working)
 *   fail=1 (every save fails)   refuse=1 (the server refuses a computer change)   theme=dark
 * Writes go through in-memory commands that answer after 400 ms; reads are
 * answered by a stubbed fetch with fixed data. A refusal carries the server's
 * reason like a real RPC error; fail=1 fails like a dropped connection.
 */
const params = new URLSearchParams(window.location.search);
const BUSY = params.get("busy") === "1";
const REFUSE = params.get("refuse") === "1";
const SAVE_DELAY = 400;

applyResolvedAppearance(params.get("theme") === "dark" ? "dark" : "light");

// The app activates the global catalog; module-level `t` calls read it too.
i18n.loadAndActivate({ locale: "en", messages: {} });

const BOT: Bot = {
  id: "bot-scout",
  spaceId: "space-1",
  name: "Scout",
  title: "Watches the inbox and flags what needs you",
  description: "Keeps the shared inbox down to what needs a person.",
  instructions:
    "You watch the shared inbox for the team and surface only what needs a person. You never reply to a sender yourself.\n\nEvery weekday morning, group what arrived overnight into three buckets: needs a decision, needs a reply, can wait.",
  color: "#3BC9A0",
  shapeSeed: null,
  notifyOnFinish: true,
  pinned: false,
  sectionId: null,
  archivedAt: null,
  unread: false,
  parentBotId: null,
  memoryScope: null,
  threadId: "thread-1",
  preview: "",
  status: BUSY ? "running" : "idle",
  computerMode: "dedicated",
  updatedAt: "2026-10-06T08:00:00.000Z",
  createdAt: "2026-09-01T08:00:00.000Z",
  voiceId: null,
  autoSpeak: false,
  chattyReplies: true,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  teamChatAmbientEnabled: false,
  teamChatRules: "",
  webhookConfigured: false,
  spawnKey: null,
};

const HOUR = 60 * 60 * 1000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();

function routine(id: string, name: string, extra: Partial<Routine> = {}): Routine {
  return {
    id,
    botId: BOT.id,
    name,
    prompt: `${name}.`,
    crons: ["0 9 * * 1-5"],
    timezone: "Europe/Paris",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: false,
    lastRunAt: at(-10 * HOUR),
    lastRunStatus: "succeeded",
    lastRunFailureKind: null,
    nextRunAt: at(14 * HOUR),
    createdAt: "2026-09-01T08:00:00.000Z",
    ...extra,
  };
}

const ROUTINES: Routine[] = [
  routine("routine-1", "Morning digest"),
  routine("routine-2", "Weekly digest", {
    crons: ["0 9 * * 1"],
    prompt:
      "Every Monday morning, sum up last week's inbox for the team: what was decided, what is still waiting, and what arrives next week. Five lines at most.",
    lastRunAt: at(-26 * HOUR),
    lastRunStatus: "failed",
    lastRunFailureKind: "provider",
    messageProvider: "slack",
  }),
  routine("routine-3", "Invoice watch", {
    crons: [],
    webhookEnabled: true,
    active: false,
    nextRunAt: null,
  }),
];

const READS: Record<string, unknown> = {
  "models/credentials": [
    {
      id: "credential-1",
      provider: "anthropic",
      label: "Anthropic",
      hasKey: true,
      isDefault: true,
      thinkingLevel: "medium",
    },
  ],
  "models/list": [
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "claude-sonnet",
      label: "Claude Sonnet",
      billing: "api",
      thinkingLevels: ["low", "medium", "high"],
    },
    {
      provider: "anthropic",
      providerName: "Anthropic",
      id: "claude-haiku",
      label: "Claude Haiku",
      billing: "api",
    },
  ],
  me: {
    userId: "user-1",
    email: "person@example.test",
    name: "Person",
    spaceId: "space-1",
    isDeploymentOwner: true,
    needsModel: false,
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet",
    computerHost: "docker",
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    avatarStyle: "organic",
  },
  "voice/voices": [
    { id: "warm", label: "Warm" },
    { id: "bright", label: "Bright" },
  ],
  "memory/list": [
    {
      id: "memory-1",
      scope: "bot",
      botId: BOT.id,
      path: "MEMORY.md",
      content: "# Scout\n\nCounsel prefers a reply before 10:00.",
      revision: 4,
      updatedAt: "2026-10-05T08:00:00.000Z",
    },
  ],
  "agentSkills/list": [
    {
      id: "skill-1",
      name: "inbox-triage",
      description: "Sorts a mailbox into decide, reply, wait.",
      source: "user",
      readOnly: false,
      availability: "all",
      visibleBotIds: [BOT.id],
    },
  ],
  "scratchpad/list": [],
  "computer/files": [
    { path: "notes", kind: "dir", size: 0 },
    { path: "inbox-report.md", kind: "file", size: 3_200 },
    { path: "q3-forecast.csv", kind: "file", size: 12_400 },
  ],
  "bots/list": [],
};

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (!url.pathname.startsWith("/rpc/")) return realFetch(input, init);
  const procedure = url.pathname.slice("/rpc/".length);
  await delay(150);
  const json = READS[procedure];
  if (json === undefined) {
    return Response.json(
      { json: { message: `${procedure} is not in this fixture` } },
      { status: 404 },
    );
  }
  return Response.json({ json });
};

function isTab(value: string | null): value is BotTab {
  return value === "routines" || value === "knowledge" || value === "settings";
}

function initialDetail(value: string | null): BotDetail | null {
  if (value === "routine") {
    return { kind: "routine", routineId: params.get("routine") ?? "routine-2" };
  }
  if (value === "routine-new") return { kind: "routine-new" };
  if (
    value === "instructions" ||
    value === "description" ||
    value === "model" ||
    value === "voice"
  ) {
    return { kind: value };
  }
  return null;
}

function Fixture() {
  const [bot, setBot] = useState(BOT);
  const botRef = useRef(bot);
  botRef.current = bot;
  const [routines, setRoutines] = useState(ROUTINES);
  const routinesRef = useRef(routines);
  routinesRef.current = routines;
  const [fail, setFail] = useState(params.get("fail") === "1");
  const failRef = useRef(fail);
  failRef.current = fail;
  const tab = params.get("tab");
  const [view, setView] = useState<BotPageView>({
    tab: isTab(tab) ? tab : "settings",
    detail: initialDetail(params.get("detail")),
  });

  const commands = useMemo<BotCommands>(() => {
    async function write(patch: Partial<Bot>, refusal: string | null): Promise<Bot> {
      await delay(SAVE_DELAY);
      if (refusal) throw new ORPCError("CONFLICT", { message: refusal });
      if (failRef.current) throw new Error("The server did not answer.");
      const next = { ...botRef.current, ...patch };
      setBot(next);
      return next;
    }
    return {
      updateBot: (_botId, patch: UpdateBotPatch) => write(patch as Partial<Bot>, null),
      setComputer: (_botId, mode) =>
        write(
          { computerMode: mode },
          botRef.current.status === "idle" && !REFUSE
            ? null
            : "Wait for this bot to finish before changing its computer.",
        ),
      async createRoutine(_botId, payload) {
        await delay(SAVE_DELAY);
        if (failRef.current) throw new Error("The server did not answer.");
        const created = routine(`routine-${Date.now()}`, payload.name, {
          ...payload,
          lastRunAt: null,
          lastRunStatus: null,
          nextRunAt: payload.crons.length > 0 ? at(20 * HOUR) : null,
        });
        setRoutines((list) => [...list, created]);
        return created;
      },
      async updateRoutine(_botId, routineId, patch) {
        await delay(SAVE_DELAY);
        if (failRef.current) throw new Error("The server did not answer.");
        const current = routinesRef.current.find((item) => item.id === routineId);
        if (!current) throw new ORPCError("NOT_FOUND", { message: "That routine is gone." });
        const { runAt: _runAt, ...fields } = patch;
        const updated = { ...current, ...fields };
        setRoutines((list) => list.map((item) => (item.id === routineId ? updated : item)));
        return updated;
      },
      async removeRoutine(_botId, routineId) {
        await delay(SAVE_DELAY);
        setRoutines((list) => list.filter((item) => item.id !== routineId));
      },
      testRun: async () => {
        await delay(SAVE_DELAY);
      },
      revealWebhookSecret: async () => {
        await delay(SAVE_DELAY);
        return "whsec_fixture_0000";
      },
      botAction: (_botId, action) => console.info(`bot action: ${action}`),
      skillsChanged: () => undefined,
    };
  }, []);

  const closeEditor = useCallback(() => setView((current) => ({ ...current, detail: null })), []);
  const closePanel = useCallback(() => console.info("close panel"), []);
  usePanelEscape({ enabled: true, editorOpen: view.detail !== null, closeEditor, closePanel });

  const size = panelSizeFor("bot", view);
  return (
    <div className="flex h-dvh bg-background text-foreground">
      <main className="flex flex-1 items-start p-4">
        <label className="flex items-center gap-2 text-meta text-muted-foreground">
          <input
            type="checkbox"
            data-testid="fixture-fail-saves"
            checked={fail}
            onChange={(event) => setFail(event.target.checked)}
          />
          Fail saves
        </label>
      </main>
      <aside
        data-testid="side-panel"
        data-panel="bot"
        data-detail={view.detail?.kind}
        data-size={size}
        className={`flex min-h-0 shrink-0 flex-col overflow-hidden border-s border-border bg-surface shadow-card ${
          size === "wide" ? "w-panel-wide" : "w-panel"
        }`}
      >
        <BotPage
          bot={bot}
          userId="user-1"
          routines={routines}
          memoryProviderConfigured={false}
          view={view}
          onView={setView}
          onClose={closePanel}
          commands={commands}
          messagingProviders={["slack"]}
        />
      </aside>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <I18nProvider i18n={i18n}>
    <SaveStoreProvider store={store}>
      <Fixture />
    </SaveStoreProvider>
  </I18nProvider>,
);
