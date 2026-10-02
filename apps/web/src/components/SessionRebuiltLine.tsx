import { t } from "@lingui/core/macro";

/** The one line a thread shows when its native session was replaced from the Rakazo history. */
export function SessionRebuiltLine() {
  return (
    <div
      className="flex items-center justify-center py-1 text-meta text-muted-foreground"
      data-testid="session-rebuilt"
    >
      {t`New session — resumed from the conversation history.`}
    </div>
  );
}
