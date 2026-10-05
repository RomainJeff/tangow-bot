import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBubble, MessageRow } from "./message-row.js";

describe("MessageRow", () => {
  it("renders the avatar column and author by default, with no fill or border of its own", () => {
    const html = renderToString(
      <MessageRow avatar={<span data-testid="avatar" />} author="Maya">
        Tuesday afternoon is free.
      </MessageRow>,
    );

    expect(html).toContain('data-slot="message-row"');
    expect(html).toContain("items-end");
    expect(html).toContain('data-slot="message-row-avatar"');
    expect(html).toContain("w-message");
    expect(html).toContain('data-testid="avatar"');
    expect(html).toContain('data-slot="message-row-author"');
    expect(html).toContain("text-author");
    expect(html).toContain("text-body");
    // The primitive itself carries no fill or border — a bubble, if any, is
    // the caller's own child.
    expect(html).not.toContain("bg-");
    expect(html).not.toContain("border");
  });

  it("hides the author and avatar for a message that is neither edge of its group", () => {
    const html = renderToString(
      <MessageRow
        avatar={<span data-testid="avatar" />}
        author="Maya"
        showAuthor={false}
        showAvatar={false}
      >
        Still going.
      </MessageRow>,
    );

    expect(html).not.toContain('data-testid="avatar"');
    expect(html).not.toContain('data-slot="message-row-author"');
    // The avatar column stays reserved (empty) so every bubble in the group
    // keeps the same indent.
    expect(html).toContain('data-slot="message-row-avatar"');
    expect(html).toContain("w-message");
  });

  it("drops the avatar column entirely in a mono (single-bot) thread", () => {
    const html = renderToString(
      <MessageRow
        avatar={<span data-testid="avatar" />}
        author="Maya"
        showAuthor={false}
        showAvatar={false}
        hasAvatarColumn={false}
      >
        hi
      </MessageRow>,
    );

    expect(html).not.toContain('data-slot="message-row-avatar"');
    expect(html).not.toContain("w-message");
    expect(html).not.toContain('data-testid="avatar"');
    expect(html).not.toContain('data-slot="message-row-author"');
  });

  it("draws a muted bubble that fits its content, 82% in mono and 88% in a group", () => {
    const mono = renderToString(<MessageBubble>hi</MessageBubble>);
    expect(mono).toContain('data-slot="message-row-bubble"');
    expect(mono).toContain("bg-muted");
    expect(mono).toContain("rounded-bubble");
    expect(mono).toContain("w-fit");
    expect(mono).toContain("max-w-41/50");

    const group = renderToString(<MessageBubble inGroup>hi</MessageBubble>);
    expect(group).toContain("max-w-22/25");
  });

  it("renders the proof line as a button inside the bubble", () => {
    const html = renderToString(
      <MessageBubble meta={{ label: "Sent to #ops" }}>done</MessageBubble>,
    );

    const bubbleAt = html.indexOf('data-slot="message-row-bubble"');
    const metaAt = html.indexOf('data-slot="message-row-meta"');
    expect(bubbleAt).toBeGreaterThanOrEqual(0);
    expect(metaAt).toBeGreaterThan(bubbleAt);
    expect(html).toContain('type="button"');
    expect(html).toContain("text-meta");
    expect(html).toContain("Sent to #ops");
  });

  it("anchors a trailing overlay inside the row", () => {
    const html = renderToString(
      <MessageRow avatar={null} author="Maya" trailing={<span data-testid="pill" />}>
        done
      </MessageRow>,
    );
    expect(html).toContain('data-testid="pill"');
  });
});
