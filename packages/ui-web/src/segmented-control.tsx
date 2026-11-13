import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { ReactNode } from "react";
import { cn } from "./lib/utils.js";

/** The pill track a segmented choice and segmented tabs share. */
export const segmentedTrackClass = "inline-flex items-center gap-0.5 rounded-full bg-muted p-0.75";

/** One segment: raised on the surface when it is the chosen one (a pressed toggle or the active tab). */
export const segmentedItemClass =
  "inline-flex h-7 max-md:h-capsule flex-1 items-center justify-center rounded-full border-0 px-3 text-label font-normal whitespace-nowrap text-muted-foreground outline-none duration-(--duration-hover) ease-quiet hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-active:bg-surface data-active:font-medium data-active:text-foreground data-active:shadow-row data-pressed:bg-surface data-pressed:font-medium data-pressed:text-foreground data-pressed:shadow-row";

export interface SegmentedControlProps<V extends string> {
  value: V;
  options: readonly { value: V; label: ReactNode }[];
  /** Called with a newly chosen value; choosing the current one again does nothing. */
  onValueChange: (value: V) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** A choice of one value among a few, shown side by side on one track. */
export function SegmentedControl<V extends string>({
  value,
  options,
  onValueChange,
  className,
  ...props
}: SegmentedControlProps<V>) {
  return (
    <ToggleGroup<V>
      data-slot="segmented-control"
      value={[value]}
      onValueChange={(values) => {
        const next = values[0];
        if (next !== undefined && next !== value) onValueChange(next);
      }}
      className={cn(segmentedTrackClass, className)}
      {...props}
    >
      {options.map((option) => (
        <Toggle key={option.value} value={option.value} className={segmentedItemClass}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}
