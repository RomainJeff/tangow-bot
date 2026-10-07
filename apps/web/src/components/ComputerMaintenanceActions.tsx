import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerStatus } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { computerUpdates } from "../lib/computer-updates";
import { rpc } from "../lib/rpc";
import { useMediaQuery } from "../lib/use-media-query";
import type { TeachMenuAction } from "./teach/TeachComputerOverlay";

type Action = "recover" | "reset" | "update";

export function ComputerMaintenanceActions({
  botId,
  computer,
  onChanged,
  teach = null,
}: {
  botId: string;
  computer: ComputerStatus | null;
  onChanged: () => Promise<void>;
  /** Teach a task, offered here only below the sm breakpoint where the chrome hides its button. */
  teach?: TeachMenuAction | null;
}) {
  const { t } = useLingui();
  // The chrome hides its Teach a task button below Tailwind's sm breakpoint (40rem).
  const teachInMenu = useMediaQuery("(min-width: 40rem)") ? null : teach;
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = Boolean(computer?.busyBotName) || computer?.state === "booting";
  const showRecover =
    computer?.state === "error" ||
    computer?.state === "running" ||
    computer?.state === "suspended" ||
    computer?.state === "stopped";
  const showReset = showRecover;
  const showUpdate = Boolean(computer?.canUpdate);
  const hasMaintenance = showRecover || showReset || showUpdate;
  if (!hasMaintenance && !teachInMenu) return null;

  async function run(action: Action) {
    setPending(action);
    setError(null);
    try {
      if (action === "recover") await computerUpdates.start(botId, "recover");
      else if (action === "reset") await rpc.computer.reset({ botId });
      else await computerUpdates.start(botId);
      setConfirmReset(false);
      setMenuOpen(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not update computer`);
    } finally {
      setPending(null);
    }
  }

  function openResetConfirm() {
    setError(null);
    setMenuOpen(false);
    setConfirmReset(true);
  }

  // Escape closes the dialog inside the popup, so Shell's Escape handler does not also
  // close the computer overlay.
  const resetDialog = (
    <AlertDialog
      open={confirmReset}
      onOpenChange={(open) => {
        if (!open) setConfirmReset(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Reset computer?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            <Trans>Restore the last saved workspace. Unsaved work on the computer is lost.</Trans>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <AlertDialogAction disabled={pending !== null} onClick={() => void run("reset")}>
            {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset</Trans>}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) setError(null);
          setMenuOpen(open);
        }}
      >
        <DropdownMenuTrigger
          data-testid="computer-more-button"
          aria-label={t`More computer actions`}
          disabled={busy && pending === null}
          render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          data-testid="computer-more-menu"
          className="w-auto min-w-44"
        >
          {teachInMenu ? (
            <DropdownMenuItem disabled={teachInMenu.disabled} onClick={teachInMenu.onSelect}>
              <Trans>Teach a task</Trans>
            </DropdownMenuItem>
          ) : null}
          {showRecover ? (
            <DropdownMenuItem
              closeOnClick={false}
              disabled={busy || pending !== null}
              onClick={() => void run("recover")}
            >
              {pending === "recover" ? <Trans>Recovering…</Trans> : <Trans>Recover computer</Trans>}
            </DropdownMenuItem>
          ) : null}
          {showReset ? (
            <DropdownMenuItem disabled={busy || pending !== null} onClick={openResetConfirm}>
              {pending === "reset" ? <Trans>Resetting…</Trans> : <Trans>Reset computer</Trans>}
            </DropdownMenuItem>
          ) : null}
          {showUpdate ? (
            <DropdownMenuItem
              closeOnClick={false}
              disabled={busy || pending !== null}
              onClick={() => void run("update")}
            >
              {pending === "update" ? <Trans>Updating…</Trans> : <Trans>Update computer</Trans>}
            </DropdownMenuItem>
          ) : null}
          {error ? <p className="px-1.5 py-1 text-[12.5px] text-destructive">{error}</p> : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {resetDialog}
    </>
  );
}
