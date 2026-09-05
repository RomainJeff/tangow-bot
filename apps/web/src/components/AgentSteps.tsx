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

/** "Steps (n)" toggle listing the tools used; each one opens its own detail popin. */
export function AgentSteps({ block }: { block: StepsBlock }) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const calls = callsOf(block);
  if (calls.length === 0) return null;
  const openCall = openIndex === null ? undefined : calls[openIndex];
  return (
    <div className="mb-1.5 flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid="agent-steps-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className="rounded-full border border-border px-3 py-1 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground/75"
      >
        <Trans>Steps ({calls.length})</Trans>
      </button>
      {expanded ? (
        <ul className="flex flex-col items-start gap-0.5 pl-1">
          {calls.map((call, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setOpenIndex(i)}
                className="rounded-md px-2 py-0.5 text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground/75"
                dir="auto"
              >
                {call.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog
        open={openCall !== undefined}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null);
        }}
      >
        <DialogContent
          data-testid="agent-steps-detail"
          className="rk-scroll block max-h-[calc(100%-2rem)] w-[720px] overflow-y-auto overscroll-contain rounded-2xl p-6 sm:max-h-[calc(100%-5rem)] sm:max-w-[calc(100%-5rem)]"
        >
          <DialogTitle className="text-xl font-medium text-foreground" dir="auto">
            {openCall?.name ?? ""}
          </DialogTitle>
          {openCall ? (
            openCall.input || openCall.output ? (
              <>
                <StepPayload label={t`Input`} value={openCall.input} />
                <StepPayload label={t`Output`} value={openCall.output} />
              </>
            ) : (
              <p className="mt-3 text-[12.5px] text-muted-foreground/80">
                <Trans>This call ran before step details were recorded.</Trans>
              </p>
            )
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepPayload({ label, value }: { label: string; value: string }) {
  const { t } = useLingui();
  return (
    <div className="mt-3">
      <p className="text-[12.5px] text-muted-foreground/80">{label}</p>
      <pre className="rk-scroll mt-1 max-h-64 overflow-auto rounded-lg bg-muted px-3 py-2 text-[12.5px] leading-[1.5] whitespace-pre-wrap text-foreground/90">
        <code>{value || t`(empty)`}</code>
      </pre>
    </div>
  );
}

/** Like isToolActivityBlock, but keeps `steps` visible when the pref is on. */
export function isHiddenActivityBlock(block: MessageBlock, showSteps: boolean): boolean {
  return isToolActivityBlock(block) && !(showSteps && block.kind === "steps");
}
