import { Check } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useId } from "react";
import { cn } from "./lib/utils.js";

export interface OptionTileProps extends ComponentPropsWithoutRef<"button"> {
  /** An option's state, announced with `aria-pressed`; left out on an action tile like Other…. */
  selected?: boolean;
  /** The answer on its way: the tile takes the user's bubble colour. */
  filled?: boolean;
  /** Replaces the selection check, such as Other…'s pencil. */
  trailing?: ReactNode;
  /** A muted line under the label, announced as the tile's description. */
  detail?: ReactNode;
}

/** One answer of a question card: a full-width tile on a hairline ring. */
export function OptionTile({
  selected,
  filled,
  trailing,
  detail,
  className,
  children,
  ...props
}: OptionTileProps) {
  const id = useId();
  return (
    <button
      type="button"
      data-slot="option-tile"
      aria-pressed={selected}
      aria-labelledby={detail ? `${id}-label` : undefined}
      aria-describedby={detail ? `${id}-detail` : undefined}
      className={cn(
        "flex min-h-13 w-full items-center gap-3 rounded-card px-4 py-3.5 text-start text-question font-medium ring-1 ring-option-ring transition-[background-color,color,box-shadow,transform] duration-(--duration-press) ease-quiet focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring enabled:hover:bg-pressed/40 enabled:hover:ring-option-ring-hover rk-press-tile",
        selected &&
          "ring-selected ring-foreground enabled:hover:bg-transparent enabled:hover:ring-foreground",
        filled && "bg-chat-user text-chat-user-foreground ring-0 duration-(--duration-fill)",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1 break-words">
        <span id={`${id}-label`} dir="auto" className="block">
          {children}
        </span>
        {detail ? (
          <span
            id={`${id}-detail`}
            dir="auto"
            className={cn("block text-meta font-normal", !filled && "text-muted-foreground")}
          >
            {detail}
          </span>
        ) : null}
      </span>
      {trailing ?? (
        <Check
          aria-hidden
          className={cn("size-4 shrink-0", selected || filled ? "opacity-100" : "opacity-0")}
        />
      )}
    </button>
  );
}
