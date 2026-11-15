import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";
import { cropForSize } from "./clay-avatar.js";

describe("cropForSize", () => {
  it.each([
    [96, "full"],
    [64, "full"],
    [56, "portrait"],
    [32, "portrait"],
    [28, "close"],
    [16, "close"],
  ])("frames a %s px avatar on the %s crop", (size, crop) => {
    expect(cropForSize(size)).toBe(crop);
  });
});

describe("BotAvatar character", () => {
  it("draws the neutral character for null and the legacy renderer for undefined", () => {
    const neutral = renderToString(<BotAvatar color="#3B82F6" character={null} size={40} />);
    const legacy = renderToString(<BotAvatar color="#3B82F6" size={40} variant="robot" />);
    expect(neutral).toContain("<img");
    expect(neutral).toContain("scout");
    expect(legacy).not.toContain("<img");
  });
});
