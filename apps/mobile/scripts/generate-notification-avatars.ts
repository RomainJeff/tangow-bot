import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NOTIFICATION_AVATAR_SWIFT_PATH,
  notificationAvatarSwift,
} from "../lib/notification-avatar-shapes";

writeFileSync(
  fileURLToPath(new URL(`../${NOTIFICATION_AVATAR_SWIFT_PATH}`, import.meta.url)),
  notificationAvatarSwift(),
);
