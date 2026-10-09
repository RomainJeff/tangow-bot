import { useLingui } from "@lingui/react/macro";
import type { Bot, Routine } from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  SettingRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import {
  Archive,
  ChevronLeft,
  Copy,
  Download,
  Eraser,
  MoreHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef } from "react";
import type { BotAction, BotCommands } from "../shell/bot-commands";
import type { BotPageView, BotTab } from "../shell/layout";
import { BotHero } from "./BotHero";
import { type BotPageContext, SettingsGroup, useBotField, useConfirm } from "./page-kit";
import { RoutinesTab } from "./RoutinesTab";
import { ModelDetail, TextDetail, VoiceDetail } from "./SettingDetails";
import { SettingsTab } from "./SettingsTab";

const KnowledgeTab = lazy(() =>
  import("./KnowledgeTab").then((module) => ({ default: module.KnowledgeTab })),
);

export interface BotPageProps {
  bot: Bot;
  userId: string;
  /** `null` until this bot's routines are read. */
  routines: Routine[] | null;
  /** The routine whose run is under way, if any. */
  runningRoutineId: string | null;
  /** Whether the bot has never run, `null` until its conversation is read. */
  neverRan: boolean | null;
  memoryProviderConfigured: boolean;
  view: BotPageView;
  onView: (view: BotPageView) => void;
  onClose: () => void;
  /** Opens a routine in the routine editor; `null` writes a new one. */
  onOpenRoutine: (routine: Routine | null) => void;
  onStopRun: () => void;
  commands: BotCommands;
}

/**
 * The bot's page in the side panel: who it is at the top, then Routines,
 * Knowledge and Settings. Every setting saves itself through `commands`; the
 * page holds no copy of the bot.
 */
export function BotPage({
  bot,
  userId,
  routines,
  runningRoutineId,
  neverRan,
  memoryProviderConfigured,
  view,
  onView,
  onClose,
  onOpenRoutine,
  onStopRun,
  commands,
}: BotPageProps) {
  const { t } = useLingui();
  const { confirm, dialog } = useConfirm();
  const root = useRef<HTMLDivElement>(null);
  const page: BotPageContext = { bot, userId, commands };
  // Instructions being saved already count, so leaving the editor shows the full page at once.
  const instructions = useBotField(page, "instructions", bot.instructions, (value) => ({
    instructions: value,
  }));
  const first =
    !instructions.value && routines?.length === 0 && bot.status === "idle" && neverRan === true;
  const detail = view.detail;
  const tabLabels: Record<BotTab, string> = {
    routines: t`Routines`,
    knowledge: t`Knowledge`,
    settings: t`Settings`,
  };
  const back = () => onView({ tab: view.tab, detail: null });

  // Focus follows the editor: into it when it opens (a text editor focuses its
  // own field), back to the row that opened it when it closes.
  const backButton = useRef<HTMLButtonElement>(null);
  const lastDetail = useRef(detail);
  useEffect(() => {
    const closed = lastDetail.current;
    lastDetail.current = detail;
    if (detail?.kind === "model" || detail?.kind === "voice") backButton.current?.focus();
    if (detail || !closed) return;
    root.current?.querySelector<HTMLElement>(`[data-opens="${closed.kind}"]`)?.focus();
  }, [detail]);

  return (
    <div
      ref={root}
      data-testid="bot-page"
      aria-busy={neverRan === null || routines === null || undefined}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center justify-between gap-1 px-2.5 pt-2.5">
        {detail ? (
          <Button
            ref={backButton}
            variant="tertiary"
            size="capsule"
            className="gap-1 ps-2"
            onClick={back}
          >
            <ChevronLeft className="size-4 rtl:-scale-x-100" aria-hidden />
            {tabLabels[view.tab]}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-0.5">
          <MoreMenu bot={bot} onAction={(action) => commands.botAction(bot.id, action)} />
          <Button variant="ghost" size="icon-sm" aria-label={t`Close panel`} onClick={onClose}>
            <X size={16} strokeWidth={1.8} />
          </Button>
        </div>
      </div>
      {detail?.kind === "instructions" || detail?.kind === "description" ? (
        <TextDetail key={detail.kind} page={page} kind={detail.kind} confirm={confirm} />
      ) : detail?.kind === "model" ? (
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto">
          <ModelDetail page={page} />
        </div>
      ) : detail?.kind === "voice" ? (
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto">
          <VoiceDetail page={page} />
        </div>
      ) : (
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto pb-4">
          <BotHero page={page} first={first} />
          {first ? (
            <div className="px-4 pt-5">
              <SettingsGroup>
                <SettingRow label={t`Instructions`} className="min-h-14.5 rounded-none ps-3.5">
                  <Button
                    variant="capsule"
                    size="capsule"
                    data-opens="instructions"
                    onClick={() => onView({ tab: "settings", detail: { kind: "instructions" } })}
                  >
                    {t`Write`}
                  </Button>
                </SettingRow>
                <SettingRow label={t`A first routine`} className="min-h-14.5 rounded-none ps-3.5">
                  <Button
                    variant="capsuleSecondary"
                    size="capsule"
                    data-testid="routine-create-button"
                    onClick={() => onOpenRoutine(null)}
                  >
                    {t`Add`}
                  </Button>
                </SettingRow>
              </SettingsGroup>
            </div>
          ) : (
            <Tabs
              value={view.tab}
              onValueChange={(tab) => onView({ tab: tab as BotTab, detail: null })}
              className="gap-0"
            >
              <div className="px-4 pt-5 pb-4">
                <TabsList variant="segmented" className="w-full">
                  {(Object.keys(tabLabels) as BotTab[]).map((tab) => (
                    <TabsTrigger key={tab} value={tab}>
                      {tabLabels[tab]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value="routines" className="px-4">
                <RoutinesTab
                  routines={routines ?? []}
                  runningRoutineId={runningRoutineId}
                  onOpen={onOpenRoutine}
                  onStop={onStopRun}
                />
              </TabsContent>
              <TabsContent value="knowledge" className="px-4">
                <Suspense fallback={null}>
                  <KnowledgeTab page={page} memoryProviderConfigured={memoryProviderConfigured} />
                </Suspense>
              </TabsContent>
              <TabsContent value="settings" className="px-4">
                <SettingsTab
                  page={page}
                  onOpen={(next) => onView({ tab: view.tab, detail: next })}
                />
              </TabsContent>
            </Tabs>
          )}
        </div>
      )}
      {dialog}
    </div>
  );
}

function MoreMenu({ bot, onAction }: { bot: Bot; onAction: (action: BotAction) => void }) {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t`Actions for ${bot.name}`}>
            <MoreHorizontal size={16} strokeWidth={1.8} />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onClick={() => onAction("duplicate")}>
          <Copy />
          {t`Duplicate`}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("export")}>
          <Download />
          {t`Export`}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onAction("clear")}>
          <Eraser />
          {t`Clear conversation`}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction("archive")}>
          <Archive />
          {t`Archive`}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => onAction("delete")}>
          <Trash2 />
          {t`Delete`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
