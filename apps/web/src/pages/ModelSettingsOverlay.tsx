import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import { localizedProviderHint } from "../lib/localized-provider-hint";
import { ModelDetail } from "./model-settings/model-detail";
import { useModelSettings } from "./model-settings/use-model-settings";

export function ModelSettingsOverlay({
  onClose,
  embedded = false,
  localOwner = false,
}: {
  onClose: () => void;
  /** Render panel body only for the shared Settings shell. */
  embedded?: boolean;
  localOwner?: boolean;
}) {
  const { t } = useLingui();
  const settings = useModelSettings();
  const {
    loading,
    me,
    currentEntry,
    providerQuery,
    setProviderQuery,
    filteredGroups,
    credentials,
    provider,
    chooseProvider,
    cancelOAuthAttempt,
  } = settings;

  function handleClose() {
    cancelOAuthAttempt(false);
    onClose();
  }

  const description = loading ? (
    <Trans>Loading model catalog…</Trans>
  ) : localOwner ? (
    <Trans>Models for the server owner’s default space.</Trans>
  ) : (
    <Trans>Choose which connected model Rakazo uses.</Trans>
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

      <div
        className={`mx-6 rounded-card bg-group shadow-group px-4 py-3 sm:mx-8 ${embedded ? "mt-4" : "mt-5"}`}
      >
        <div className="text-[12.5px] uppercase tracking-[0.08em] text-muted-foreground/80">
          <Trans>Active model</Trans>
        </div>
        <div className="mt-1 text-[16px] text-foreground">
          {currentEntry?.label ?? me?.defaultModel ?? t`Deployment default`}
        </div>
        <div className="mt-1 text-[13px] text-muted-foreground">
          {currentEntry?.providerName ?? me?.defaultProvider ?? (
            <Trans>Configured by deployment</Trans>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-hidden px-6 py-6 sm:px-8 md:flex-row">
        <div className="flex min-h-0 shrink-0 flex-col md:w-[310px]">
          <div className="mb-3 text-[13.5px] text-muted-foreground">
            <Trans>Providers</Trans>
          </div>
          <label className="sr-only" htmlFor="model-provider-search">
            <Trans>Search providers</Trans>
          </label>
          <Input
            id="model-provider-search"
            value={providerQuery}
            onChange={(event) => setProviderQuery(event.target.value)}
            placeholder={t`Search providers`}
            className="h-10 rounded-xl px-3.5"
          />
          <div className="rk-scroll mt-3 max-h-[240px] overflow-y-auto rounded-card bg-group shadow-group md:min-h-0 md:max-h-none md:flex-1">
            {filteredGroups.length ? (
              filteredGroups.map((group) => {
                const connected = credentials.some((entry) => entry.provider === group.id);
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => chooseProvider(group.id)}
                    className={`flex w-full items-center gap-3 border-b border-border px-3.5 py-3 text-start last:border-0 ${
                      group.id === provider ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] text-foreground">
                        {group.name}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-muted-foreground/80">
                        <Plural value={group.entries.length} one="# model" other="# models" />
                        {" · "}
                        {localizedProviderHint(group.entries[0]!)}
                      </span>
                    </span>
                    {connected ? (
                      <span className="text-[12px] text-success">
                        <Trans>Connected</Trans>
                      </span>
                    ) : null}
                  </button>
                );
              })
            ) : (
              <p className="px-3.5 py-4 text-[13px] text-muted-foreground">
                <Trans>No providers found.</Trans>
              </p>
            )}
          </div>
        </div>

        <ModelDetail settings={settings} />
      </div>
    </>
  );

  if (embedded) {
    return (
      <div data-testid="model-settings" className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
        className="flex h-[760px] max-h-[calc(100%-2rem)] w-[min(1080px,calc(100%-2rem))] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1080px]"
      >
        {body}
      </DialogContent>
    </Dialog>
  );
}
