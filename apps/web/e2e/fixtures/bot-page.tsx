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
 *   tab=routines|knowledge|settings   detail=instructions|description|model|voice
 *   first=1 (a bot with nothing set up yet)   busy=1 (the bot is working)
 *   fail=1 (every save fails)   refuse=1 (the server refuses a computer change)   theme=dark
 * Writes go through in-memory commands that answer after 400 ms; reads are
 * answered by a stubbed fetch with fixed data. A refusal carries the server's
 * reason like a real RPC error; fail=1 fails like a dropped connection.
 */
const params = new URLSearchParams(window.location.search);
const FIRST = params.get("first") === "1";
const BUSY = params.get("busy") === "1";
const REFUSE = params.get("refuse") === "1";
const SAVE_DELAY = 400;

applyResolvedAppearance(params.get("theme") === "dark" ? "dark" : "light");

// The app activates the global catalog; module-level `t` calls read it too.
i18n.loadAndActivate({ locale: "en", messages: {} });

const BOT: Bot = {
  id: "bot-scout",
  spaceId: "space-1",
  name: FIRST ? "Ledger" : "Scout",
  title: FIRST ? "" : "Watches the inbox and flags what needs you",
  description: FIRST ? "" : "Keeps the shared inbox down to what needs a person.",
  instructions: FIRST
    ? ""
    : "You watch the shared inbox for the team and surface only what needs a person. You never reply to a sender yourself.\n\nEvery weekday morning, group what arrived overnight into three buckets: needs a decision, needs a reply, can wait.",
  color: FIRST ? "#2E8CF0" : "#3BC9A0",
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
    lastRunAt: null,
    nextRunAt: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    ...extra,
  };
}

const ROUTINES: Routine[] = FIRST
  ? []
  : [
      routine("routine-1", "Morning digest"),
      routine("routine-2", "Weekly digest", { crons: ["0 9 * * 1"] }),
      routine("routine-3", "Invoice watch", { crons: [], webhookEnabled: true, active: false }),
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
  "memory/list": FIRST
    ? []
    : [
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
  "computer/files": FIRST
    ? []
    : [
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
      botAction: (_botId, action) => console.info(`bot action: ${action}`),
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
          routines={ROUTINES}
          runningRoutineId={null}
          neverRan={FIRST}
          memoryProviderConfigured={false}
          view={view}
          onView={setView}
          onClose={closePanel}
          onOpenRoutine={(item) => console.info(`open routine: ${item?.id ?? "new"}`)}
          onStopRun={() => console.info("stop run")}
          commands={commands}
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
