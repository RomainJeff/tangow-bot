import { isWorkingStatus } from "@tangow/core";
import { memo } from "react";
import { ClayAvatar } from "./clay-avatar.js";
import { faceFor } from "./clay-face-data.js";
import { cn } from "./lib/utils.js";

export interface BotAvatarProps {
  size?: number;
  status?: string;
  /** Catalogue character; missing or unknown shows the neutral character. */
  character?: string | null;
  /** Keeps the face alive at rest, over its body, instead of the still image. */
  live?: boolean;
  className?: string;
}

export const BotAvatar = memo(function BotAvatar({
  size = 38,
  status,
  character,
  live = false,
  className,
}: BotAvatarProps) {
  return (
    <ClayAvatar
      character={character ?? null}
      size={size}
      isWorking={isWorkingStatus(status)}
      face={
        live ? { expression: faceFor(character).defaut, gaze: "free", motion: "expression" } : null
      }
      className={className}
    />
  );
});

export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div className="flex h-11 w-11 items-center justify-center gap-1.5 rounded-full bg-card">
        <span className="h-4 w-[7px] rounded-full bg-primary" />
        <span className="h-4 w-[7px] rounded-full bg-primary" />
      </div>
      <span className="font-sans text-[28px] tracking-tight text-foreground">Tangow</span>
    </div>
  );
}
