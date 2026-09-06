import { describe, expect, it } from "vitest";
import { PROFILE_PHOTO_MAX_LENGTH, profilePhotoDataUrl } from "./profile-photo.js";

describe("profilePhotoDataUrl", () => {
  it("builds a WebP data URL the server guard accepts", () => {
    expect(profilePhotoDataUrl("aGVsbG8=")).toEqual({
      ok: true,
      dataUrl: "data:image/webp;base64,aGVsbG8=",
    });
  });

  it("reports an encoder that returned nothing", () => {
    expect(profilePhotoDataUrl(null)).toEqual({ ok: false, reason: "unreadable" });
    expect(profilePhotoDataUrl("")).toEqual({ ok: false, reason: "unreadable" });
  });

  it("rejects a photo the session payload could not carry", () => {
    const oversize = "a".repeat(PROFILE_PHOTO_MAX_LENGTH);
    expect(profilePhotoDataUrl(oversize)).toEqual({ ok: false, reason: "too-large" });
  });

  it("accepts a photo that exactly fills the cap", () => {
    const prefix = "data:image/webp;base64,".length;
    const exact = "a".repeat(PROFILE_PHOTO_MAX_LENGTH - prefix);
    expect(profilePhotoDataUrl(exact).ok).toBe(true);
  });
});
