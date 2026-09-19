import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Children, isValidElement, useId } from "react";
import { cn } from "./lib/utils.js";
import { Shimmer } from "./shimmer.js";

/**
 * JSX lets any hyphenated attribute through, but an object literal is checked
 * against the declared props, so `toggleProps` has to say that data attributes
 * are welcome.
 */
export type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface ReasoningDisclosureProps
  extends Omit<ComponentPropsWithoutRef<"div">, "children" | "onToggle"> {
  /** "Thought for 41s · 4 steps", already translated. */
  summary: ReactNode;
  open: boolean;
  onToggle: () => void;
  /** One node per step. */
  children: ReactNode;
  /** The run is still going: the last step shimmers. */
  live?: boolean;
  /** Lands on the toggle, for a testid or an extra description. */
  toggleProps?: ComponentPropsWithoutRef<"button"> & DataAttributes;
}

/** What the bot thought, folded away until someone asks. */
export function ReasoningDisclosure({
  summary,
  open,
  onToggle,
  children,
  live,
  toggleProps,
  className,
  ...props
}: ReasoningDisclosureProps) {
  const panelId = useId();
  const steps = Children.toArray(children);
  const lastIndex = steps.length - 1;
  return (
    <div
      data-slot="reasoning-disclosure"
      data-open={open ? "true" : undefined}
      className={className}
      {...props}
    >
      <button
        type="button"
        data-slot="reasoning-disclosure-toggle"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={onToggle}
        className="flex items-center gap-2 text-reasoning text-muted-foreground duration-(--duration-hover) ease-quiet hover:text-foreground"
        {...toggleProps}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 transition-transform duration-(--duration-hover) ease-quiet",
            open && "rotate-90",
          )}
        />
        {summary}
      </button>
      {open ? (
        <div
          id={panelId}
          data-slot="reasoning-disclosure-steps"
          className="mt-2 flex flex-col gap-2.25 border-s-2 border-border ps-3 text-reasoning text-muted-foreground"
        >
          {steps.map((step, index) => {
            if (!live || index !== lastIndex) return step;
            // Keyed off the child itself, so appending a step does not remount
            // the shimmer on the one that was already live.
            const key = isValidElement(step) ? step.key : null;
            return <Shimmer key={key ?? "live"}>{step}</Shimmer>;
          })}
        </div>
      ) : null}
    </div>
  );
}
