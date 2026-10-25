import { Trans, useLingui } from "@lingui/react/macro";
import type { AskDraft } from "@rakazo/contracts";
import { draftSentLine, draftSentTo } from "@rakazo/core";
import { Check } from "lucide-react";
import { AppLogo } from "./AppLogo";

/**
 * A sent draft on the bot's paper: the success disc leads, then who it went to and the one line
 * the message keeps, behind its app's mark. It is the one place a success check is not grey.
 */
export function DraftSent({ draft, time }: { draft: AskDraft; time: string }) {
  const { t } = useLingui();
  const recipient = draftSentTo(draft);
  return (
    <div className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 text-foreground">
      <span
        aria-hidden="true"
        className="row-span-2 grid size-7 place-items-center rounded-full bg-success text-primary-foreground"
      >
        <Check className="size-4" strokeWidth={2.6} />
      </span>
      <span className="text-title">{t`Sent`}</span>
      <span className="justify-self-end text-time tabular-nums text-muted-foreground">{time}</span>
      <span className="col-span-2 truncate text-meta text-muted-foreground">
        <Trans>
          to <span className="text-foreground">{recipient}</span>
        </Trans>
      </span>
      <span className="col-span-2 mt-3 flex min-w-0 items-center gap-2 text-row-name">
        <AppLogo app={draft.app} chat={Boolean(draft.conversation)} />
        <span className="min-w-0 truncate">{draftSentLine(draft)}</span>
      </span>
    </div>
  );
}
