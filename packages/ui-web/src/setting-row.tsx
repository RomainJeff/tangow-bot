import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";

interface SettingRowContent {
  label: ReactNode;
  /** An avatar or a dot ahead of the label. */
  leading?: ReactNode;
  /** One quiet line under the label. */
  subline?: ReactNode;
  /** A read-only figure on the trailing side, allowed on a pressable row too. */
  value?: ReactNode;
  /** Marks a row that opens something. */
  chevron?: boolean;
}

interface SettingRowTrailing {
  /** A `SaveMeta`, shown ahead of the trailing control. */
  meta?: ReactNode;
  /** The trailing control or value: a switch, a select, the current choice. */
  children?: ReactNode;
}

type Omitted<P> = Omit<P, keyof SettingRowContent | keyof SettingRowTrailing>;

export type SettingRowProps = SettingRowContent &
  (
    | (Omitted<ComponentPropsWithoutRef<"button">> & {
        onClick: () => void;
        meta?: never;
        children?: never;
      })
    | (Omitted<ComponentPropsWithoutRef<"div">> & SettingRowTrailing & { onClick?: undefined })
  );

const rowClass = "flex min-h-12.5 w-full items-center gap-3 py-2.5 ps-3.5 pe-3 text-start";
const pressableClass =
  "outline-none duration-(--duration-hover) ease-quiet hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One line of a settings list: a label, an optional sub-line, and on the
 * trailing side a control, a value, or a chevron. Static by default; with
 * `onClick` it is a button, which carries a sub-line and a chevron, never a
 * control or a `SaveMeta`: those would nest an interactive element inside another.
 */
export function SettingRow({
  label,
  leading,
  subline,
  value,
  meta,
  children,
  chevron,
  className,
  ...props
}: SettingRowProps) {
  const body = (
    <>
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span data-slot="setting-row-label" className="text-row-name text-foreground">
          {label}
        </span>
        {subline ? (
          <span data-slot="setting-row-subline" className="text-row-status text-muted-foreground">
            {subline}
          </span>
        ) : null}
      </span>
      {value ? (
        <span
          data-slot="setting-row-value"
          className="flex shrink-0 flex-col items-end text-meta text-muted-foreground tabular-nums"
        >
          {value}
        </span>
      ) : null}
      {meta}
      {children ? (
        <span
          data-slot="setting-row-trailing"
          className="flex shrink-0 items-center text-meta text-muted-foreground"
        >
          {children}
        </span>
      ) : null}
      {chevron ? (
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
        />
      ) : null}
    </>
  );

  if (props.onClick !== undefined) {
    return (
      <button
        type="button"
        data-slot="setting-row"
        className={cn(rowClass, pressableClass, className)}
        {...props}
      >
        {body}
      </button>
    );
  }
  return (
    <div data-slot="setting-row" className={cn(rowClass, className)} {...props}>
      {body}
    </div>
  );
}
