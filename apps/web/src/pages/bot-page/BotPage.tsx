import { useLingui } from "@lingui/react/macro";
import type { Bot, Routine } from "@rakazo/contracts";
import { routineFailing } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import {
  Archive,
  ArchiveRestore,
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
import { type BotDetail, type BotPageView, type BotTab, detailOpener } from "../shell/layout";
import { BotActivity } from "./BotActivity";
import { BotHero } from "./BotHero";
import type { BotPageContext } from "./page-kit";
import { useBotField, useConfirm } from "./page-kit";
import { RoutineCreateForm } from "./RoutineCreateForm";
import { RoutineDetail } from "./RoutineDetail";
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
  memoryProviderConfigured: boolean;
  view: BotPageView;
  onView: (view: BotPageView) => void;
  onClose: () => void;
  commands: BotCommands;
  /** Message integrations a routine can be triggered from. */
  messagingProviders: string[];
}

/**
 * The bot's page in the side panel: who it is at the top, then Activity,
 * Routines, Knowledge and Settings. Every setting saves itself through
 * `commands`; the page holds no copy of the bot. An archived bot's page only
 * reads: who it is and its activity, until it is restored.
 */
export function BotPage({
  bot,
  userId,
  routines,
  memoryProviderConfigured,
  view,
  onView,
  onClose,
  commands,
  messagingProviders,
}: BotPageProps) {
  const { t } = useLingui();
  const { confirm, dialog } = useConfirm();
  const root = useRef<HTMLDivElement>(null);
  const archived = bot.archivedAt !== null;
  const page: BotPageContext = { bot, userId, commands, readOnly: archived };
  // Instructions being saved already count, so the link to write them goes as the editor closes.
  const instructions = useBotField(page, "instructions", bot.instructions, (value) => ({
    instructions: value,
  }));
  const detail = archived ? null : view.detail;
  const routine =
    detail?.kind === "routine" ? routines?.find((item) => item.id === detail.routineId) : undefined;
  const routineFailed = routines?.some(routineFailing) ?? false;
  const tabLabels: Record<BotTab, string> = {
    activity: t`Activity`,
    routines: t`Routines`,
    knowledge: t`Knowledge`,
    settings: t`Settings`,
  };
  const open = (next: BotDetail) => onView({ tab: view.tab, detail: next });
  const back = () => onView({ tab: view.tab, detail: null });
  const toRoutines = () => onView({ tab: "routines", detail: null });

  // A routine that is gone (deleted here or elsewhere) leaves its tab showing.
  const missingRoutine = detail?.kind === "routine" && routines !== null && !routine;
  useEffect(() => {
    if (missingRoutine) onView({ tab: "routines", detail: null });
  }, [missingRoutine, onView]);

  // Focus follows the editor: into it when it opens (a text editor focuses its
  // own field), back to the row that opened it when it closes.
  const backButton = useRef<HTMLButtonElement>(null);
  const lastDetail = useRef(detail);
  useEffect(() => {
    const closed = lastDetail.current;
    lastDetail.current = detail;
    if (detail?.kind === "model" || detail?.kind === "voice") backButton.current?.focus();
    if (detail || !closed) return;
    root.current?.querySelector<HTMLElement>(`[data-opens="${detailOpener(closed)}"]`)?.focus();
  }, [detail]);

  return (
    <div
      ref={root}
      data-testid="bot-page"
      aria-busy={(!archived && routines === null) || undefined}
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
          <MoreMenu
            bot={bot}
            archived={archived}
            onAction={(action) => commands.botAction(bot.id, action)}
          />
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
      ) : detail?.kind === "routine" ? (
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto">
          {routine ? (
            <RoutineDetail
              key={routine.id}
              page={page}
              routine={routine}
              messageProviders={messagingProviders}
              confirm={confirm}
              onDeleted={toRoutines}
            />
          ) : null}
        </div>
      ) : detail?.kind === "routine-new" ? (
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto">
          <RoutineCreateForm
            key={detail.seed ? `${detail.seed.name}\n${detail.seed.prompt}` : ""}
            page={page}
            seed={detail.seed}
            messageProviders={messagingProviders}
            confirm={confirm}
            onCreated={(created) =>
              onView({ tab: "routines", detail: { kind: "routine", routineId: created.id } })
            }
          />
        </div>
      ) : (
        <div className="rk-scroll min-h-0 flex-1 overflow-y-auto pb-4">
          <BotHero page={page} />
          {archived ? (
            <div className="px-4 pt-5">
              <BotActivity botId={bot.id} commands={{ activityEpoch: commands.activityEpoch }} />
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
                    <TabsTrigger
                      key={tab}
                      value={tab}
                      data-testid={`bot-tab-${tab}`}
                      aria-label={
                        tab === "activity" && routineFailed
                          ? t`Activity, last run failed`
                          : undefined
                      }
                      className="gap-1.5"
                    >
                      {tabLabels[tab]}
                      {tab === "activity" && routineFailed ? (
                        <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                      ) : null}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              <TabsContent value="activity" className="px-4">
                <BotActivity
                  botId={bot.id}
                  commands={commands}
                  onWriteInstructions={
                    instructions.value
                      ? undefined
                      : () => onView({ tab: "activity", detail: { kind: "instructions" } })
                  }
                  onOpenRoutine={(routineId) =>
                    onView({ tab: "routines", detail: { kind: "routine", routineId } })
                  }
                />
              </TabsContent>
              <TabsContent value="routines" className="px-4">
                <RoutinesTab page={page} routines={routines} onOpen={open} />
              </TabsContent>
              <TabsContent value="knowledge" className="px-4">
                <Suspense fallback={null}>
                  <KnowledgeTab page={page} memoryProviderConfigured={memoryProviderConfigured} />
                </Suspense>
              </TabsContent>
              <TabsContent value="settings" className="px-4">
                <SettingsTab page={page} onOpen={open} />
              </TabsContent>
            </Tabs>
          )}
        </div>
      )}
      {dialog}
    </div>
  );
}

function MoreMenu({
  bot,
  archived,
  onAction,
}: {
  bot: Bot;
  archived: boolean;
  onAction: (action: BotAction) => void;
}) {
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
        {archived ? (
          // What the archived list offers: the server refuses everything else on an archived bot.
          <DropdownMenuItem onClick={() => onAction("restore")}>
            <ArchiveRestore />
            {t`Restore`}
          </DropdownMenuItem>
        ) : (
          <>
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
          </>
        )}
        <DropdownMenuItem variant="destructive" onClick={() => onAction("delete")}>
          <Trash2 />
          {t`Delete`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
