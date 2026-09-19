import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("ChatMarkdown", () => {
  it("renders the formatting commonly emitted by assistants", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"## Capabilities\n\n- **Write files**\n- Run `commands`"}</ChatMarkdown>,
    );

    expect(html).toContain("<h2>Capabilities</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>Write files</strong>");
    expect(html).toContain("<code>commands</code>");
  });

  it("does not inject raw HTML or unsafe link protocols", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{'<script>alert("xss")</script> [bad](javascript:alert(1))'}</ChatMarkdown>,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it("renders incomplete streaming code fences as code", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown streaming>{"```ts\nconst live = true;"}</ChatMarkdown>,
    );

    expect(html).toContain("<pre>");
    expect(html).toContain("const live = true;");
    expect(html).toContain("rk-chat-markdown-cursor");
  });

  it("renders a copy button alongside each code block", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"```ts\nconst value = 1;\n```"}</ChatMarkdown>,
    );

    expect(html).toContain("rk-chat-markdown-pre-wrap");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain("rk-chat-markdown-copy");
  });

  it("renders images by default (normal bot messages)", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"![logo](https://example.com/logo.png)"}</ChatMarkdown>,
    );

    expect(html).toContain("<img");
  });

  it("drops every image when allowImages is false, whatever the URL form", () => {
    for (const src of [
      "https://tracker.example/pixel.png",
      "tracker.example/pixel.gif",
      "//tracker.example/pixel.gif",
    ]) {
      const html = renderToStaticMarkup(
        <ChatMarkdown allowImages={false}>{`digest ![x](${src}) end`}</ChatMarkdown>,
      );

      expect(html).not.toContain("<img");
      expect(html).not.toContain("tracker.example");
    }
  });
});
