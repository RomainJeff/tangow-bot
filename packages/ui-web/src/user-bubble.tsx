import type { ComponentPropsWithoutRef } from "react";
import { cn } from "./lib/utils.js";

export type UserBubbleProps = ComponentPropsWithoutRef<"div">;

/** What the person said, the only filled bubble of the thread. */
export function UserBubble({ className, ...props }: UserBubbleProps) {
  return (
    <div
      data-slot="user-bubble"
      className={cn(
        // 39/50 is 78% — a fraction rather than an arbitrary width.
        "max-w-39/50 self-end whitespace-pre-wrap rounded-bubble bg-chat-user px-4 py-3 text-body text-chat-user-foreground",
        className,
      )}
      {...props}
    />
  );
}
