import { type ComponentPropsWithoutRef, useState } from "react";
import { cn } from "./lib/utils.js";

export interface UserAvatarProps extends ComponentPropsWithoutRef<"span"> {
  initials: string;
  /** Profile photo shown instead of the initials, initials on failure. */
  image?: string | null;
}

/** The person, in the colour of their own bubbles. Size it through className or style. */
export function UserAvatar({ initials, image, className, ...props }: UserAvatarProps) {
  // Tracking the failed source (not a boolean) retries on the next photo.
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const photo = image && image !== failedImage ? image : null;
  return (
    <span
      data-slot="user-avatar"
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden rounded-full bg-chat-user font-semibold text-chat-user-foreground",
        className,
      )}
      {...props}
    >
      {photo ? (
        <img
          src={photo}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedImage(photo)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
