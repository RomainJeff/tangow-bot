import { ChevronRight } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "./lib/utils.js";

interface SettingRowContent {
  label: ReactNode;
  /** One quiet line under the label. */
  subline?: ReactNode;
  /** A `SaveMeta`, shown ahead of the trailing control. */
  meta?: ReactNode;
  /** The trailing control or value: a switch, a select, the current choice. */
  children?: ReactNode;
  /** Marks a row that opens something. */
  chevron?: boolean;
}

type Omitted<P> = Omit<P, keyof SettingRowContent>;

export type SettingRowProps = SettingRowContent &
  (
    | (Omitted<ComponentPropsWithoutRef<"a">> & { href: string })
    | (Omitted<ComponentPropsWithoutRef<"button">> & { href?: undefined; onClick: () => void })
    | (Omitted<ComponentPropsWithoutRef<"div">> & { href?: undefined; onClick?: undefined })
  );

const rowClass = "flex w-full items-center gap-3 rounded-row px-3 py-2.5 text-start";
const pressableClass =
  "outline-none duration-(--duration-hover) ease-quiet hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * One line of a settings list: a label, an optional sub-line, and on the
 * trailing side a control, a value, or a chevron. Static by default; with
 * `href` it is a link, and with `onClick` a button. A link or button row
 * carries a value and a chevron, never a control or a `SaveMeta`: those would
 * nest an interactive element inside another.
 */
export function SettingRow({
  label,
  subline,
  meta,
  children,
  chevron,
  className,
  ...props
}: SettingRowProps) {
  const body = (
    <>
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

  if (props.href !== undefined) {
    return (
      <a data-slot="setting-row" className={cn(rowClass, pressableClass, className)} {...props}>
        {body}
      </a>
    );
  }
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
