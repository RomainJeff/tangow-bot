import { describe, expect, it } from "vitest";
import { APP_MARKS, appIcon, appMarkId } from "./app-marks.js";

describe("app marks", () => {
  it("picks the bundled mark an app name asks for", () => {
    expect(appMarkId("Gmail")).toBe("gmail");
    expect(appMarkId("Google Mail")).toBe("gmail");
    expect(appMarkId("Slack")).toBe("slack");
    expect(appMarkId("Microsoft Outlook")).toBe("outlook");
    expect(appMarkId("Outlook")).toBe("outlook");
    expect(appMarkId("Fastmail")).toBeNull();
  });

  it("prefers the catalog logo, then the bundled mark, then a neutral glyph", () => {
    expect(appIcon({ name: "Gmail", logo: "https://logo.example/gmail.svg" }, false)).toEqual({
      kind: "logo",
      uri: "https://logo.example/gmail.svg",
    });
    expect(appIcon({ name: "Gmail", logo: null }, false)).toEqual({
      kind: "mark",
      mark: APP_MARKS.gmail,
    });
    expect(appIcon({ name: "Fastmail", logo: null }, false)).toEqual({
      kind: "glyph",
      glyph: "mail",
    });
    expect(appIcon({ name: "Mattermost", logo: null }, true)).toEqual({
      kind: "glyph",
      glyph: "message",
    });
  });
});
