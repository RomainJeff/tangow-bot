import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { forwardRef } from "react";
import { cn } from "./lib/utils.js";

export type ComposerState = "idle" | "typing" | "dictating" | "speaking" | "working";

const BAR_DELAYS_MS = [0, 140, 280, 420];
const DOT_DELAYS_MS = [0, 160, 320];

export interface ComposerShellProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  /** A mention chip, or the avatar of the bot that is speaking. */
  leading?: ReactNode;
  /** The field itself. */
  children: ReactNode;
  /** `roundIcon` buttons: attach, dictate, send, stop. */
  trailing?: ReactNode;
  state?: ComposerState;
}

/** The capsule at the bottom of the thread — the one elevation of the screen. */
export const ComposerShell = forwardRef<HTMLDivElement, ComposerShellProps>(function ComposerShell(
  { leading, children, trailing, state = "idle", className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-slot="composer-shell"
      data-state={state}
      className={cn(
        "flex items-center gap-2.5 rounded-composer bg-surface py-1.75 pe-1.75 shadow-composer transition-[box-shadow,border-color] duration-(--duration-hover) ease-quiet focus-within:ring-1 focus-within:ring-border",
        leading ? "ps-2.5" : "ps-4",
        className,
      )}
      {...props}
    >
      {leading}
      {state === "dictating" ? (
        <span aria-hidden="true" data-slot="composer-dictating" className="flex items-end gap-0.75">
          {BAR_DELAYS_MS.map((delay) => (
            <span
              key={delay}
              className="rk-bar h-3.5 w-0.75 rounded-full bg-foreground"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      ) : null}
      {state === "working" ? (
        <span aria-hidden="true" data-slot="composer-working" className="flex items-center gap-1">
          {DOT_DELAYS_MS.map((delay) => (
            <span
              key={delay}
              className="rk-dot size-1 rounded-full bg-foreground"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
      ) : null}
      <div data-slot="composer-shell-field" className="min-w-0 flex-1">
        {children}
      </div>
      {trailing}
    </div>
  );
});

ComposerShell.displayName = "ComposerShell";
