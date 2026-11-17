import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotAvatar } from "./bot-avatar.js";

describe("BotAvatar character", () => {
  it("draws the neutral character for null and the legacy renderer for undefined", () => {
    const neutral = renderToString(<BotAvatar color="#3B82F6" character={null} size={40} />);
    const legacy = renderToString(<BotAvatar color="#3B82F6" size={40} variant="robot" />);
    expect(neutral).toContain("<img");
    expect(neutral).toContain("scout");
    expect(legacy).not.toContain("<img");
  });

  it("serves the mini image up to 20 px and the full image above", () => {
    const small = renderToString(<BotAvatar color="#3B82F6" character="scout" size={20} />);
    const larger = renderToString(<BotAvatar color="#3B82F6" character="scout" size={21} />);
    expect(small).toContain("scout-mini");
    expect(larger).not.toContain("scout-mini");
  });
});
