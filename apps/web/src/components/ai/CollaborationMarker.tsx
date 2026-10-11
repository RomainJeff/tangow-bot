import type { GroupAvatarMember, StackedAvatarItem } from "@rakazo/ui-web";
import { GroupAvatar, Interstitial, StackedAvatars, WorkingLine } from "@rakazo/ui-web";

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
  label: string;
  /** Absent for a peer the app cannot open, such as another owner's agent. */
  onClick?: () => void;
  /** A message still waiting on its answer. */
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <Interstitial
        data-testid="peer-receipt-chip"
        aria-label={ariaLabel}
        className={muted ? "opacity-60" : undefined}
        // Unlabelled on purpose: the button's own name says who the exchange
        // was with, so the stack is decoration.
        avatars={<StackedAvatars items={bots} size={17} />}
        onClick={onClick}
      >
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
