import { Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@tangow/ui-web";
import { X } from "lucide-react";
import { RoutingSettings } from "./model-settings/routing-settings";
import { useModelSettings } from "./model-settings/use-model-settings";

export function ModelSettingsOverlay({
  onClose,
  embedded = false,
}: {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
}) {
  const { t } = useLingui();
  const settings = useModelSettings();
  const { loading, cancelOAuthAttempt } = settings;

  function handleClose() {
    cancelOAuthAttempt(false);
    onClose();
  }

  const description = loading ? (
    <Trans>Loading model catalog…</Trans>
  ) : (
    <Trans>Choose which connected model Tangow uses.</Trans>
  );

  const body = (
    <>
      {!embedded ? (
        <DialogHeader className="flex-row items-start justify-between px-6 pt-6 sm:px-8 sm:pt-7">
          <div>
            <DialogTitle className="text-2xl text-foreground">
              <Trans>Models</Trans>
            </DialogTitle>
            <DialogDescription className="mt-1 text-[13.5px] text-muted-foreground/70">
              {description}
            </DialogDescription>
          </div>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t`Close model settings`} />}
          >
            <X />
          </DialogClose>
        </DialogHeader>
      ) : (
        <p className="px-6 pt-1 text-[13.5px] text-muted-foreground/70 sm:px-8">{description}</p>
      )}

      <RoutingSettings settings={settings} />

      {settings.error ? (
        <p className="mx-6 mt-4 text-sm text-destructive sm:mx-8">{settings.error}</p>
      ) : null}
    </>
  );

  if (embedded) {
    return (
      <div data-testid="model-settings" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {body}
      </div>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        variant="window"
        showCloseButton={false}
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-y-auto p-0 sm:max-w-[1080px]"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
