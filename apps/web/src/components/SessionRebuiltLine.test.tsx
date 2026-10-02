import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SessionRebuiltLine } from "./SessionRebuiltLine";

// The node test run has no Lingui vite transform; substitute the runtime tag with a plain
// interpolation. The guarantee under test is the one quiet line a rebuilt session leaves.
vi.mock("@lingui/core/macro", () => ({
  t: (strings: TemplateStringsArray) => strings.join(""),
}));

describe("SessionRebuiltLine", () => {
  it("says the session was resumed from the history, with nothing to act on", () => {
    const html = renderToStaticMarkup(<SessionRebuiltLine />);
    expect(html).toContain("New session — resumed from the conversation history.");
    expect(html).not.toMatch(/<(button|a)[\s>]/);
  });
});
