import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";
import { useElapsed } from "./use-elapsed.js";

export interface WorkingLineProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** A working `BotAvatar` at the `message` size. Omit it for no avatar column at all. */
  avatar?: ReactNode;
  /** "Maya is drafting the recap", already translated. */
  label: ReactNode;
  /** Epoch ms the run started. Falls back to mount time. */
  startedAt?: number;
}

/** The only thing that moves while a bot works. */
export function WorkingLine({ avatar, label, startedAt, className, ...props }: WorkingLineProps) {
  const elapsed = useElapsed(startedAt);
  return (
    <div
      data-slot="working-line"
      role="status"
      className={cn("flex items-center gap-3.5", className)}
      {...props}
    >
      {avatar ? <span className="w-message shrink-0">{avatar}</span> : null}
      <span
        data-slot="working-line-label"
        className="min-w-0 truncate text-working text-muted-foreground"
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        data-slot="working-line-elapsed"
        className="font-mono text-mono text-muted-foreground tabular-nums"
      >
        {elapsed}
      </span>
    </div>
  );
}
