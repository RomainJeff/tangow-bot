import { t } from "@lingui/core/macro";
import type { PendingWorkAsk } from "@rakazo/contracts";
import type { AskBlock } from "./AskCard";
import { AskCard } from "./AskCard";

/**
 * A specialist's pending ask rendered in its coordinator's thread. The provenance line
 * names the specialist and the coordinator that delegated the work; the actions and the
 * answer flow are the original ask's, settled through `works.answer` by the caller.
 */
export function WorkAskCard({
  pendingWork,
  error,
  onAnswer,
}: {
  pendingWork: PendingWorkAsk;
  error?: string | null;
  onAnswer: (text: string) => Promise<void>;
}) {
  const askBlock = pendingWork.message.blocks.find(
    (block): block is AskBlock => block.kind === "ask",
  );
  if (!askBlock) return null;
  return (
    <div className="flex flex-col items-start gap-1" data-testid="work-ask-card">
      <div className="text-label text-muted-foreground">
        {t`${pendingWork.specialist.name} · delegated by ${pendingWork.coordinator.name}`}
      </div>
      <AskCard block={askBlock} canAnswer onAnswer={onAnswer} messageId={pendingWork.message.id} />
      {error ? <p className="text-meta text-destructive">{error}</p> : null}
    </div>
  );
}
