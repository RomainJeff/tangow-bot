import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { ApprovalRulesSettings } from "../components/ApprovalRulesSettings";

export function SpaceGeneralSettings({
  messagingEnabled = false,
  onOpenMessaging,
}: {
  messagingEnabled?: boolean;
  onOpenMessaging?: () => void;
}) {
  return (
    <div className="space-y-5">
      {messagingEnabled && onOpenMessaging ? (
        <section className="rounded-card bg-group shadow-group px-4 py-4">
          <h3 className="text-[15px] font-medium text-foreground">
            <Trans>Messaging</Trans>
          </h3>
          <p className="mt-3 text-[13px] text-muted-foreground/70">
            <Trans>Chat apps, group channels, and agent connections.</Trans>
          </p>
          <Button variant="secondary" className="mt-3 rounded-full" onClick={onOpenMessaging}>
            <Trans>Manage messaging settings</Trans>
          </Button>
        </section>
      ) : null}

      <details data-testid="advanced-settings" className="group rounded-card bg-group shadow-group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 text-[14px] text-foreground/75">
          <span>
            <span className="block text-[15px] text-foreground">
              <Trans>Advanced</Trans>
            </span>
            <span className="mt-1 block text-[12.5px] text-muted-foreground/80">
              <Trans>Optional controls most people never need</Trans>
            </span>
          </span>
          <span aria-hidden="true" className="transition-transform group-open:rotate-90">
            ›
          </span>
        </summary>
        <div className="border-t border-border px-4 pb-5">
          <ApprovalRulesSettings />
        </div>
      </details>
    </div>
  );
}
