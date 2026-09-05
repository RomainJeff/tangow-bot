import { Trans, useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "@rakazo/core";
import { Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { useState } from "react";

type StepsBlock = Extract<MessageBlock, { kind: "steps" }>;
type StepCall = { name: string; input: string; output: string };

function callsOf(block: StepsBlock): StepCall[] {
  return block.steps.flatMap((step) =>
    step.calls?.length
      ? step.calls
      : Array.from({ length: step.count }, () => ({ name: step.label, input: "", output: "" })),
  );
}

/** "Steps (n)" toggle plus the per-tool input/output detail popin. */
export function AgentSteps({ block }: { block: StepsBlock }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const calls = callsOf(block);
  if (calls.length === 0) return null;
  return (
    <div className="mb-1.5 flex justify-start">
      <button
        type="button"
        data-testid="agent-steps-toggle"
        onClick={() => setOpen(true)}
        className="rounded-full border border-border px-3 py-1 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground/75"
      >
        <Trans>Steps ({calls.length})</Trans>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          data-testid="agent-steps-detail"
          className="rk-scroll block max-h-[calc(100%-2rem)] w-[720px] overflow-y-auto overscroll-contain rounded-2xl p-6 sm:max-h-[calc(100%-5rem)] sm:max-w-[calc(100%-5rem)]"
        >
          <DialogTitle className="text-xl font-medium text-foreground">
            <Trans>Agent steps</Trans>
          </DialogTitle>
          <ol className="mt-5 space-y-5">
            {calls.map((call, i) => (
              <li key={i} className="rounded-xl border border-border px-4 py-4">
                <h4 className="text-[15px] font-medium text-foreground" dir="auto">
                  {call.name}
                </h4>
                <StepPayload label={t`Input`} value={call.input} />
                <StepPayload label={t`Output`} value={call.output} />
              </li>
            ))}
          </ol>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepPayload({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-3">
      <p className="text-[12.5px] text-muted-foreground/80">{label}</p>
      <pre className="rk-scroll mt-1 max-h-64 overflow-auto rounded-lg bg-muted px-3 py-2 text-[12.5px] leading-[1.5] whitespace-pre-wrap text-foreground/90">
        <code>{value || "—"}</code>
      </pre>
    </div>
  );
}

/** Like isToolActivityBlock, but keeps `steps` visible when the pref is on. */
export function isHiddenActivityBlock(block: MessageBlock, showSteps: boolean): boolean {
  return isToolActivityBlock(block) && !(showSteps && block.kind === "steps");
}
