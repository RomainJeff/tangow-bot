import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UserBubble } from "./user-bubble.js";

describe("UserBubble", () => {
  it("is the one filled bubble of the thread", () => {
    const html = renderToString(<UserBubble>Book it{"\n"}please</UserBubble>);

    expect(html).toContain('data-slot="user-bubble"');
    expect(html).toContain("rounded-bubble");
    expect(html).toContain("bg-chat-user");
    expect(html).toContain("text-chat-user-foreground");
    expect(html).toContain("text-body");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("self-end");
    expect(html).toContain("max-w-39/50");
  });

  it("passes a className through", () => {
    const html = renderToString(<UserBubble className="mt-2">hi</UserBubble>);
    expect(html).toContain("mt-2");
  });
});
