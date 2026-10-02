import { Plural } from "@lingui/react/macro";
import type { TaskTreeNode } from "@rakazo/contracts";
import { cn } from "@rakazo/ui-web";
import { ChevronRight } from "lucide-react";
import { createContext, useContext, useEffect, useRef } from "react";
import { taskCount } from "../../lib/task-tree";
import { TaskTree } from "./TaskTree";

export type WorkTreeValue = {
  tasks: readonly TaskTreeNode[];
  /** The card the tree is unfolded under; one at a time. */
  openCard: string | null;
  toggle: (cardKey: string) => void;
  deciderName?: string;
  errorFor: (workId: string) => string | null;
  onCancel: (node: TaskTreeNode) => void;
  onClose: (node: TaskTreeNode) => void;
  onViewThread: (node: TaskTreeNode) => void;
};

export const WorkTreeContext = createContext<WorkTreeValue | null>(null);

/**
 * The quiet link under a delegated-work card, and the tree it unfolds. It exists only where the
 * thread has delegated work, and only one card holds the tree open at a time.
 */
export function TaskTreeDisclosure({ cardKey }: { cardKey: string }) {
  const tree = useContext(WorkTreeContext);
  const root = useRef<HTMLDivElement>(null);
  const expanded = tree?.openCard === cardKey;
  // The card sits at the foot of the thread: bring what just unfolded into view.
  useEffect(() => {
    if (expanded) root.current?.scrollIntoView({ block: "nearest" });
  }, [expanded]);
  if (!tree || tree.tasks.length === 0) return null;
  const count = taskCount(tree.tasks);
  return (
    <div ref={root} className="self-stretch" data-testid="task-tree-disclosure">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => tree.toggle(cardKey)}
        className="mt-1.75 flex items-center gap-1 text-meta text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground"
      >
        <Plural value={count} one={`${count} task`} other={`${count} tasks`} />
        <ChevronRight aria-hidden className={cn("size-3", expanded && "rotate-90")} />
      </button>
      {expanded ? (
        <TaskTree
          nodes={tree.tasks}
          deciderName={tree.deciderName}
          errorFor={tree.errorFor}
          onCancel={tree.onCancel}
          onClose={tree.onClose}
          onViewThread={tree.onViewThread}
        />
      ) : null}
    </div>
  );
}
