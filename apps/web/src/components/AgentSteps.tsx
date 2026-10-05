import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { MessageBlock } from "@rakazo/contracts";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  formatShortDuration,
  ReasoningDisclosure,
} from "@rakazo/ui-web";
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

/** How long the bot thought and what it did, folded away; each step opens its detail popin. */
export function AgentSteps({ block, live = false }: { block: StepsBlock; live?: boolean }) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const calls = callsOf(block);
  if (calls.length === 0) return null;
  const openCall = openIndex === null ? undefined : calls[openIndex];
  const stepCount = calls.length;
  const duration = block.durationMs === undefined ? null : formatShortDuration(block.durationMs);
  return (
    <div className="mb-1.5">
      <ReasoningDisclosure
        open={expanded}
        onToggle={() => setExpanded((open) => !open)}
        live={live}
        toggleProps={{ "data-testid": "agent-steps-toggle" }}
        summary={
          duration === null ? (
            <Plural value={stepCount} one="# step" other="# steps" />
          ) : (
            <Trans>
              Thought for {duration} · <Plural value={stepCount} one="# step" other="# steps" />
            </Trans>
          )
        }
      >
        {calls.map((call, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setOpenIndex(i)}
            className="self-start text-start duration-(--duration-hover) ease-quiet hover:text-foreground"
            dir="auto"
          >
            {call.name}
          </button>
        ))}
      </ReasoningDisclosure>
      <Dialog
        open={openCall !== undefined}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null);
        }}
      >
        <DialogContent
          data-testid="agent-steps-detail"
          className="rk-scroll block max-h-[calc(100%-2rem)] w-[720px] overflow-y-auto overscroll-contain rounded-block p-6 sm:max-h-[calc(100%-5rem)] sm:max-w-[calc(100%-5rem)]"
        >
          <DialogTitle className="text-title font-medium text-foreground" dir="auto">
            {openCall?.name ?? ""}
          </DialogTitle>
          {openCall ? (
            openCall.input || openCall.output ? (
              <>
                {/* A native harness's action carries its input only; no empty Output block. */}
                {openCall.input ? <StepPayload label={t`Input`} value={openCall.input} /> : null}
                {openCall.output ? <StepPayload label={t`Output`} value={openCall.output} /> : null}
              </>
            ) : (
              <p className="mt-3 text-label text-muted-foreground/80">
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
  return (
    <div className="mt-3">
      <p className="text-label text-muted-foreground/80">{label}</p>
      <pre className="rk-scroll mt-1 max-h-64 overflow-auto rounded-row bg-muted px-3 py-2 text-mono leading-[1.5] whitespace-pre-wrap text-foreground/90">
        <code>{value}</code>
      </pre>
    </div>
  );
}
