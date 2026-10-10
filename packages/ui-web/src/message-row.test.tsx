import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageBubble, MessageMeta, MessageRow } from "./message-row.js";

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

  it("renders the proof line as a link inside the bubble", () => {
    const html = renderToString(
      <MessageBubble meta={{ label: "Sent to #ops", onClick: () => undefined }}>
        done
      </MessageBubble>,
    );

    const bubbleAt = html.indexOf('data-slot="message-row-bubble"');
    const metaAt = html.indexOf('data-slot="message-row-meta"');
    expect(bubbleAt).toBeGreaterThanOrEqual(0);
    expect(metaAt).toBeGreaterThan(bubbleAt);
    expect(html).toContain('role="link"');
    expect(html).toContain("text-meta");
    expect(html).toContain("Sent to #ops");
  });

  it("renders a proof line with nothing to open as plain text", () => {
    const html = renderToString(
      <MessageBubble meta={{ label: "Sent to #ops" }}>done</MessageBubble>,
    );

    expect(html).toContain('data-slot="message-row-meta"');
    expect(html).toContain("Sent to #ops");
    expect(html).not.toContain("<button");
  });

  it("stacks several proof lines under the text, each with its own icon and link", () => {
    const html = renderToString(
      <MessageBubble
        meta={[
          {
            label: "From Weekly review",
            icon: <svg data-testid="repeat" />,
            onClick: () => undefined,
          },
          {
            label: "Skill updated · Invoices",
            icon: <svg data-testid="book" />,
            onClick: () => undefined,
          },
        ]}
      >
        done
      </MessageBubble>,
    );

    expect(html.match(/data-slot="message-row-meta"/g)).toHaveLength(2);
    expect(html.indexOf("From Weekly review")).toBeLessThan(
      html.indexOf("Skill updated · Invoices"),
    );
    expect(html.indexOf('data-testid="repeat"')).toBeLessThan(html.indexOf("From Weekly review"));
    expect(html.indexOf('data-testid="book"')).toBeLessThan(html.indexOf("Skill updated"));
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain("truncate");
  });

  it("draws proof lines alone, with no bubble, when there is no text", () => {
    const html = renderToString(
      <MessageMeta lines={{ label: "Skill learned · Invoices", onClick: () => undefined }} />,
    );

    expect(html).toContain("Skill learned · Invoices");
    expect(html).not.toContain('data-slot="message-row-bubble"');
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
