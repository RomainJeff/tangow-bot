import { useLingui } from "@lingui/react/macro";
import type { Bot } from "@rakazo/contracts";
import { saveKey } from "@rakazo/core";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  type FieldSave,
  type SaveMetaLabels,
  Skeleton,
  Surface,
  useFieldSave,
} from "@rakazo/ui-web";
import { Children, Fragment, type ReactNode, useCallback, useState } from "react";
import type { BotCommands, UpdateBotPatch } from "../shell/bot-commands";

/** What every part of the page works on. */
export type BotPageContext = {
  bot: Bot;
  userId: string;
  commands: BotCommands;
  /** An archived bot's page only reads: the server refuses its edits until it is restored. */
  readOnly: boolean;
};

/** One bot setting, saved through the shared store under this person, space, bot and field. */
export function useBotField<V>(
  { bot, userId, commands }: BotPageContext,
  field: string,
  serverValue: V,
  patch: (value: V) => UpdateBotPatch,
): FieldSave<V> {
  return useFieldSave({
    key: saveKey({ userId, spaceId: bot.spaceId }, bot.id, field),
    serverValue,
    commit: async (value) => {
      await commands.updateBot(bot.id, patch(value));
    },
  });
}

export function useSaveLabels(): SaveMetaLabels & { restore: string } {
  const { t } = useLingui();
  return {
    saving: t`Saving…`,
    saved: t`Saved`,
    failed: t`Could not save`,
    retry: t`Retry`,
    restore: t`Restore unsaved text`,
  };
}

/** A labelled group of rows on one surface, with hairlines inset from the leading edge. */
export function SettingsGroup({ label, children }: { label?: ReactNode; children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <section className="flex flex-col gap-1.5">
      {label ? <h2 className="mx-3.5 text-label text-muted-foreground">{label}</h2> : null}
      <Surface className="overflow-hidden bg-background">
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <div aria-hidden className="ms-3.5 h-px bg-border" /> : null}
            {row}
          </Fragment>
        ))}
      </Surface>
    </section>
  );
}

/** "Could not load · Retry", in place of what failed to read. */
export function CouldNotLoad({ onRetry, className }: { onRetry: () => void; className: string }) {
  const { t } = useLingui();
  return (
    <p className={`text-muted-foreground ${className}`}>
      {t`Could not load`}
      {" · "}
      <Button
        type="button"
        variant="link"
        onClick={onRetry}
        className="h-auto rounded-chip p-0 align-baseline text-meta font-normal text-inherit underline hover:text-foreground"
      >
        {t`Retry`}
      </Button>
    </p>
  );
}

/** Rows that keep the height of what is loading; never a bare spinner. */
export function LoadingRows() {
  return (
    <div aria-busy className="flex flex-col">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex min-h-11 items-center gap-2.5">
          <Skeleton className="size-4.5 rounded-full" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-12" />
        </div>
      ))}
    </div>
  );
}

/** What stands in for a read not answered yet: loading rows, or "Could not load · Retry". */
export function PendingRead({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  return failed ? (
    <CouldNotLoad onRetry={onRetry} className="py-10 text-center text-meta" />
  ) : (
    <LoadingRows />
  );
}

export type Confirm = (title: string, action?: string) => Promise<boolean>;

/** A destructive yes/no asked in place, answered as a promise. The action defaults to "Clear". */
export function useConfirm(): { confirm: Confirm; dialog: ReactNode } {
  const { t } = useLingui();
  const [pending, setPending] = useState<{
    title: string;
    action: string | undefined;
    resolve: (confirmed: boolean) => void;
  } | null>(null);
  const confirm = useCallback<Confirm>(
    (title, action) => new Promise<boolean>((resolve) => setPending({ title, action, resolve })),
    [],
  );
  const answer = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
  };
  const dialog = pending ? (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) answer(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{pending.title}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => answer(true)}>
            {pending.action ?? t`Clear`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  ) : null;
  return { confirm, dialog };
}
