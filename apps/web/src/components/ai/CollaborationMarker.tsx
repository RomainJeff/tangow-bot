import type { GroupAvatarMember, StackedAvatarItem } from "@tangow/ui-web";
import { cn, GroupAvatar, Interstitial, StackedAvatars, WorkingLine } from "@tangow/ui-web";
import type { ReactNode } from "react";

/** Lightweight peer event shown without exposing the exchanged message body. */
export function CollaborationMarker({
  ariaLabel,
  bots,
  label,
  onClick,
  muted = false,
}: {
  ariaLabel: string;
  /** The bots the exchange involved, sender first. */
  bots: StackedAvatarItem[];
  label: ReactNode;
  onClick?: () => void;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <Interstitial
        data-testid="peer-receipt-chip"
        role="group"
        aria-label={ariaLabel}
        className={cn(
          "relative",
          onClick && "duration-(--duration-hover) ease-quiet hover:opacity-60",
          muted && "opacity-60",
        )}
        avatars={<StackedAvatars items={bots} size={17} />}
      >
        {/* A sibling stretched under the label, not a wrapper: the label may hold its own link. */}
        {onClick ? (
          <button
            type="button"
            aria-label={ariaLabel}
            onClick={onClick}
            className="absolute inset-0"
          />
        ) : null}
        <span dir="auto">{label}</span>
      </Interstitial>
    </div>
  );
}

/** The bottom-of-thread working state: the only thing that keeps moving during a run. */
export function ActiveBotGlyph({
  bots,
  label,
  startedAt,
}: {
  bots: GroupAvatarMember[];
  label: string;
  /** Epoch ms the run started. Falls back to mount time when omitted. */
  startedAt?: number;
}) {
  return (
    <div className="flex min-h-10 items-center px-1">
      <WorkingLine
        avatar={<GroupAvatar members={bots} size={28} />}
        label={label}
        startedAt={startedAt}
      />
    </div>
  );
}
