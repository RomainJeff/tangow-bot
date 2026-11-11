import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ComputerStatus } from "@tangow/contracts";
import { Maximize2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ScreenLinkHandlers } from "./screen-frame";
import { ScreenFrame } from "./screen-frame";

/** The side panel's view of the bot's screen: a still preview that opens the full window. */
export function ComputerPreview({
  bot,
  computer,
  computerOpen,
  booting,
  embeddedScreenUrl,
  computerScreenError,
  screenLink,
  openComputer,
}: {
  bot: Bot;
  computer: ComputerStatus | null;
  computerOpen: boolean;
  booting: boolean;
  embeddedScreenUrl: string | null;
  computerScreenError: ReactNode;
  screenLink: ScreenLinkHandlers;
  openComputer: () => Promise<void>;
}) {
  const { t } = useLingui();
  return (
    <div>
      <div
        data-testid="computer-preview"
        className="group relative aspect-[16/10] overflow-hidden rounded-card bg-group shadow-group"
      >
        {computerOpen ? (
          <div className="grid h-full place-items-center text-meta text-muted-foreground/80">
            <Trans>Open in full window</Trans>
          </div>
        ) : computer?.state === "running" && embeddedScreenUrl && !computerScreenError ? (
          <ScreenFrame
            url={embeddedScreenUrl}
            title={t`Bot screen preview`}
            allow="clipboard-read; clipboard-write"
            interactive={false}
            handlers={screenLink}
          />
        ) : (
          <div className="grid h-full place-items-center px-6 text-center text-meta text-muted-foreground/80">
            {computerScreenError ??
              computerPlaceholder(
                computer?.state,
                booting,
                computerLabel(computer?.mode, bot.name),
              )}
          </div>
        )}
        {!computerScreenError ? (
          <button
            type="button"
            data-testid="computer-preview-open"
            className="absolute inset-0 flex cursor-pointer items-center justify-center bg-overlay/40 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            aria-label={t`Open`}
            onClick={() => void openComputer()}
          >
            <span className="inline-flex items-center gap-2 rounded-full bg-overlay px-3.5 py-2 text-capsule text-foreground shadow-floating">
              <Maximize2 size={15} strokeWidth={1.9} aria-hidden />
              <Trans>Open</Trans>
            </span>
          </button>
        ) : null}
      </div>
      {computer?.updateAvailable ? (
        <p role="status" className="mt-2 text-meta text-muted-foreground">
          <Trans>Update available</Trans>
        </p>
      ) : null}
      <p className="mt-2 truncate text-reasoning text-muted-foreground" dir="auto">
        {t`${bot.name}'s screen`}
      </p>
    </div>
  );
}

function computerPlaceholder(
  state: ComputerStatus["state"] | undefined,
  booting: boolean,
  label: string,
) {
  if (state === "booting" || booting) return t`Booting live desktop…`;
  if (state === "running") return label;
  if (state === "suspended") return t`Computer is asleep. Open it to wake.`;
  if (state === "error") return t`Computer failed to boot`;
  return t`Computer is stopped`;
}

export function computerLabel(mode: ComputerStatus["mode"] | undefined, botName: string) {
  return mode === "dedicated" ? t`${botName}’s computer` : t`Team Computer`;
}
