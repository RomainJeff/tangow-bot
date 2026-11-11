import { type CSSProperties, memo } from "react";
import { BotAvatar } from "./bot-avatar.js";
import { cn } from "./lib/utils.js";
import { UserAvatar } from "./user-avatar.js";

export interface GroupAvatarMember {
  botId?: string;
  name?: string;
  color: string;
  shapeSeed?: number | null;
  status?: string;
}

export interface GroupAvatarProps {
  members: GroupAvatarMember[];
  size?: number;
  className?: string;
  /** When set, a one-bot group pairs the bot with the user's initials. */
  userInitials?: string;
  /** Profile photo shown instead of the initials tile, initials on failure. */
  userImage?: string | null;
}

export const GroupAvatar = memo(function GroupAvatar({
  members,
  size = 38,
  className,
  userInitials,
  userImage,
}: GroupAvatarProps) {
  const firstMember = members[0];
  if (!firstMember) {
    return (
      <div
        className={cn(
          "tangow-group-avatar relative flex items-center justify-center rounded-full border border-border bg-muted text-muted-foreground",
          className,
        )}
        style={{ width: size, height: size, flex: "none" }}
      >
        <svg
          aria-hidden="true"
          width={Math.round(size * 0.48)}
          height={Math.round(size * 0.48)}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      </div>
    );
  }

  if (members.length === 1 && !userInitials && !userImage) {
    return (
      <BotAvatar
        color={firstMember.color}
        identity={firstMember.botId ?? firstMember.name}
        shapeSeed={firstMember.shapeSeed}
        size={size}
        status={firstMember.status}
        className={cn("tangow-group-avatar", className)}
      />
    );
  }

  const withUser = members.length === 1;
  const pair = withUser || members.length === 2;
  const miniSize = Math.round(size * (pair ? 0.65 : 0.54));
  const positions: CSSProperties[] = pair
    ? [
        { top: 0, left: 0 },
        { right: 0, bottom: 0 },
      ]
    : [
        { top: 0, left: (size - miniSize) / 2 },
        { bottom: 0, left: 0 },
        { right: 0, bottom: 0 },
      ];
  const visibleMembers = members.slice(0, pair || members.length === 3 ? members.length : 2);

  return (
    <div
      className={cn("tangow-group-avatar relative rounded-full select-none", className)}
      style={{ width: size, height: size, flex: "none" }}
    >
      {visibleMembers.map((member, index) => (
        <div
          key={member.botId ?? index}
          className="absolute rounded-full"
          style={{
            ...positions[index],
            zIndex: index + 1,
            boxShadow: "0 0 0 1.5px var(--accent)",
          }}
        >
          <BotAvatar
            color={member.color}
            identity={member.botId ?? member.name}
            shapeSeed={member.shapeSeed}
            size={miniSize}
            status={member.status}
          />
        </div>
      ))}
      {withUser ? (
        <UserAvatar
          initials={userInitials ?? ""}
          image={userImage}
          className="absolute right-0 bottom-0 z-[2]"
          style={{
            width: miniSize,
            height: miniSize,
            fontSize: Math.max(8, Math.round(miniSize * 0.4)),
            boxShadow: "0 0 0 1.5px var(--accent)",
          }}
        />
      ) : null}
      {members.length > 3 ? (
        <div
          className="absolute right-0 bottom-0 z-[3] flex items-center justify-center rounded-full bg-accent text-label font-semibold text-foreground"
          style={{
            width: miniSize,
            height: miniSize,
            boxShadow: "0 0 0 1.5px var(--accent)",
          }}
        >
          {`+${members.length - 2}`}
        </div>
      ) : null}
    </div>
  );
});
