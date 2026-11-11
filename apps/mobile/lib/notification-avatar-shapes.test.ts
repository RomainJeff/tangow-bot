import { readFileSync } from "node:fs";
import { SHAPES } from "@tangow/core";
import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_AVATAR_SWIFT_PATH,
  notificationAvatarShapes,
  notificationAvatarSwift,
} from "./notification-avatar-shapes";

describe("notification avatar shapes", () => {
  it("exports every bloub silhouette with two eyes", () => {
    const shapes = notificationAvatarShapes();
    expect(shapes).toHaveLength(SHAPES.length);
    for (const shape of shapes) {
      expect(shape.curves.length).toBeGreaterThan(8);
      expect(shape.eyes).toHaveLength(2);
      for (const eye of shape.eyes) {
        expect(eye.radius).toBeLessThanOrEqual(Math.min(eye.halfWidth, eye.halfHeight));
      }
    }
  });

  it("keeps the iOS notification extension in sync with the bloub engine", () => {
    const committed = readFileSync(
      new URL(`../${NOTIFICATION_AVATAR_SWIFT_PATH}`, import.meta.url),
      "utf8",
    );
    expect(
      committed,
      "Run `pnpm --filter @tangow/mobile generate:notification-avatars` after changing a bloub shape.",
    ).toBe(notificationAvatarSwift());
  });
});
