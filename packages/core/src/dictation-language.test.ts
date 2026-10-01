import { describe, expect, it } from "vitest";
import { writtenLanguage } from "./dictation-language.js";

describe("writtenLanguage", () => {
  it("reads French from someone's messages", () => {
    expect(
      writtenLanguage(["est-ce que ça marche quand je parle", "trouve-moi une raquette"]),
    ).toBe("fr");
  });

  it("reads English", () => {
    expect(writtenLanguage(["can you check what is on my calendar for this week"])).toBe("en");
  });

  it("stays silent on too little or mixed text", () => {
    expect(writtenLanguage(["ok"])).toBeUndefined();
    expect(writtenLanguage([])).toBeUndefined();
  });
});
