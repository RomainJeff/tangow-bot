import { ChevronRight } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./lib/utils.js";

export interface InterstitialProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** Usually a `StackedAvatars` at the `interstitial` size. */
  avatars: ReactNode;
  children: ReactNode;
  onClick?: () => void;
}

/**
 * A handoff between two bots, centred between messages: who talked to whom,
 * quiet enough to skip.
 */
export function Interstitial({
  avatars,
  children,
  onClick,
  className,
  ...props
}: InterstitialProps) {
  const content = (
    <>
      {avatars}
      <span className="min-w-0 truncate">{children}</span>
      <ChevronRight aria-hidden="true" className="size-3" />
    </>
  );
  const shared = cn(
    "flex items-center gap-2.25 self-center px-1 py-0.5 text-meta text-muted-foreground",
    className,
  );
  if (!onClick) {
    return (
      <div data-slot="interstitial" className={shared} {...props}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-slot="interstitial"
      onClick={onClick}
      className={cn(shared, "duration-(--duration-hover) ease-quiet hover:opacity-60")}
      {...props}
    >
      {content}
    </button>
  );
}
