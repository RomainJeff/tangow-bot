import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";

export interface StackLineProps
  extends Omit<ComponentPropsWithoutRef<"button">, "children" | "value"> {
  /** The question's header, or the question itself when it has none. */
  label: ReactNode;
  /** The answer, already put in words: a label, several joined, typed text or Skipped. */
  value: ReactNode;
}

/** An answered question of a stack, folded above the current one; pressing it opens it again. */
export function StackLine({ label, value, className, ...props }: StackLineProps) {
  return (
    <button
      type="button"
      data-slot="stack-line"
      className={cn(
        "-mx-2 flex min-h-11 items-center gap-2 rounded-row px-2 py-2.5 text-start text-row-name transition-colors duration-(--duration-hover) ease-quiet focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring enabled:hover:bg-pressed",
        className,
      )}
      {...props}
    >
      <span dir="auto" className="max-w-1/2 shrink-0 truncate text-muted-foreground">
        {label}
      </span>
      <span dir="auto" className="min-w-0 flex-1 truncate text-foreground">
        {value}
      </span>
      <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
