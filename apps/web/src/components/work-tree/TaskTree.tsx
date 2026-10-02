import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { TaskApproval, TaskTreeNode } from "@rakazo/contracts";
import { isNativeHarness, NATIVE_HARNESSES } from "@rakazo/contracts";
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { ChevronRight, Ellipsis } from "lucide-react";
import { useState } from "react";
import type { TaskLineState } from "../../lib/task-tree";
import {
  canCancelTask,
  canCloseTask,
  taskHarnessReason,
  taskLineState,
} from "../../lib/task-tree";
import { outcomeMark } from "./outcome-mark";

export type TaskTreeActions = {
  onCancel: (node: TaskTreeNode) => void;
  onClose: (node: TaskTreeNode) => void;
  onViewThread: (node: TaskTreeNode) => void;
};

type TaskTreeProps = TaskTreeActions & {
  nodes: readonly TaskTreeNode[];
  /** Who settled the approvals; the owner is the only one who ever does. */
  deciderName?: string;
  errorFor: (workId: string) => string | null;
};

function stateMark(state: TaskLineState): { glyph: string | null; tone: string; label: string } {
  if (state === "running") return { glyph: null, tone: "", label: t`Running` };
  if (state === "waiting") return { glyph: null, tone: "", label: t`Needs your call` };
  if (state === "closed") return { glyph: "✓", tone: "text-muted-foreground", label: t`Closed` };
  const mark = outcomeMark(state === "done" ? "result" : state);
  return mark ?? { glyph: null, tone: "", label: "" };
}

function StateMark({ state }: { state: TaskLineState }) {
  const { glyph, tone } = stateMark(state);
  if (glyph) {
    return (
      <span className={tone} aria-hidden>
        {glyph}
      </span>
    );
  }
  // A filled ink dot waits for an answer; a ring is still running.
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        state === "waiting" ? "bg-foreground" : "border border-foreground",
      )}
    />
  );
}

function engineName(harness: TaskTreeNode["harness"]): string {
  return isNativeHarness(harness) ? NATIVE_HARNESSES[harness].name : t`Rakazo`;
}

function choiceReason(node: TaskTreeNode): string | null {
  const reason = taskHarnessReason(node);
  if (reason === "explicit") return t`chosen explicitly`;
  if (reason === "profile") return t`set by its profile`;
  if (reason === "automatic") return t`picked automatically`;
  if (reason === "default") return t`default`;
  return null;
}

function EngineLine({ node }: { node: TaskTreeNode }) {
  const reason = choiceReason(node);
  return (
    <span className="text-meta text-muted-foreground">
      {reason ? `${engineName(node.harness)} · ${reason}` : engineName(node.harness)}
    </span>
  );
}

function ResultDisclosure({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 self-start text-meta text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground"
      >
        <ChevronRight aria-hidden className={cn("size-3", open && "rotate-90")} />
        {t`Result`}
      </button>
      {open ? (
        <div className="ps-4 text-body text-foreground" dir="auto">
          <ChatMarkdown>{text}</ChatMarkdown>
        </div>
      ) : null}
    </div>
  );
}

function settledText(approval: TaskApproval, name?: string): string | null {
  if (approval.status === "pending") return null;
  const denied = approval.status === "denied";
  if (name) {
    if (denied) return t`denied by ${name}`;
    return approval.status === "always_allowed"
      ? t`always allowed by ${name}`
      : t`allowed by ${name}`;
  }
  if (denied) return t`Denied`;
  return approval.status === "always_allowed" ? t`Always allowed` : t`Allowed once`;
}

/** What each approval asked and, once settled, who decided it; it is settled from its card in the thread. */
function Approvals({ node, deciderName }: { node: TaskTreeNode; deciderName?: string }) {
  if (node.approvals.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2">
      {node.approvals.map((approval) => {
        const settled = settledText(approval, deciderName);
        return (
          <li
            key={approval.effectId}
            className={cn("text-body", settled ? "text-muted-foreground" : "text-foreground")}
          >
            {settled ? `${approval.summary} · ${settled}` : approval.summary}
          </li>
        );
      })}
    </ul>
  );
}

function TaskMenu({ node, actions }: { node: TaskTreeNode; actions: TaskTreeActions }) {
  const { t } = useLingui();
  const name = node.executor.name || t`Specialist`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="roundIcon" size="roundIconSm" aria-label={t`Actions for ${name}`} />
        }
      >
        <Ellipsis aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto">
        {canCancelTask(node) ? (
          <DropdownMenuItem variant="destructive" onClick={() => actions.onCancel(node)}>
            {t`Cancel`}
          </DropdownMenuItem>
        ) : null}
        {canCloseTask(node) ? (
          <DropdownMenuItem onClick={() => actions.onClose(node)}>{t`Close`}</DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => actions.onViewThread(node)}>
          {t`View thread`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskLine({
  node,
  deciderName,
  errorFor,
  ...actions
}: Omit<TaskTreeProps, "nodes"> & { node: TaskTreeNode }) {
  const state = taskLineState(node);
  const error = errorFor(node.workId);
  return (
    <li className="flex flex-col gap-1.5" data-testid="task-tree-line">
      <div className="flex items-center gap-2.5">
        <span className="flex w-3 shrink-0 justify-center">
          <StateMark state={state} />
        </span>
        <span className="min-w-0 flex-1 truncate text-author" dir="auto">
          {node.executor.name || t`Specialist`}
        </span>
        <span className="shrink-0 text-meta text-muted-foreground">{stateMark(state).label}</span>
        <TaskMenu node={node} actions={actions} />
      </div>
      <div className="flex flex-col gap-1.5 ps-5.5">
        <EngineLine node={node} />
        {node.result?.text ? <ResultDisclosure text={node.result.text} /> : null}
        <Approvals node={node} deciderName={deciderName} />
        {error ? <p className="text-meta text-destructive">{error}</p> : null}
      </div>
      {node.children.length > 0 ? (
        <ul className="ms-1.5 mt-1.5 flex flex-col gap-3.5 border-s border-border ps-3">
          {node.children.map((child) => (
            <TaskLine
              key={child.workId}
              node={child}
              deciderName={deciderName}
              errorFor={errorFor}
              {...actions}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** The tasks a coordinator delegated, each with what its specialist delegated in turn. */
export function TaskTree({ nodes, ...rest }: TaskTreeProps) {
  return (
    <ul className="mt-3 flex flex-col gap-4" data-testid="task-tree">
      {nodes.map((node) => (
        <TaskLine key={node.workId} node={node} {...rest} />
      ))}
    </ul>
  );
}
