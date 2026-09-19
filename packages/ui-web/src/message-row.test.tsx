import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageRow } from "./message-row.js";

describe("MessageRow", () => {
  it("renders prose with no fill and no border", () => {
    const html = renderToString(
      <MessageRow avatar={<span>avatar</span>} author="Maya" time="09:12">
        Tuesday afternoon is free.
      </MessageRow>,
    );

    expect(html).toContain('data-slot="message-row"');
    expect(html).toContain("group relative flex gap-3.5");
    expect(html).toContain("w-message");
    expect(html).toContain("text-author");
    expect(html).toContain("text-time");
    expect(html).toContain("text-body");
    expect(html).not.toContain("bg-");
    expect(html).not.toContain("border");
  });

  it("omits the time when there is none", () => {
    const html = renderToString(
      <MessageRow avatar={null} author="Maya">
        hi
      </MessageRow>,
    );
    expect(html).not.toContain('data-slot="message-row-time"');
  });

  it("renders the proof line as a button", () => {
    const html = renderToString(
      <MessageRow avatar={null} author="Maya" meta={{ label: "Sent to #ops" }}>
        done
      </MessageRow>,
    );

    expect(html).toContain('data-slot="message-row-meta"');
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

  it("renders the avatar and header when not continued", () => {
    const html = renderToString(
      <MessageRow avatar={<span data-testid="avatar" />} author="Maya" time="09:12">
        Tuesday afternoon is free.
      </MessageRow>,
    );

    expect(html).toContain('data-testid="avatar"');
    expect(html).toContain('data-slot="message-row-author"');
    expect(html).not.toContain('data-continued="true"');
  });

  it("suppresses the avatar and header when continued, and reveals the time on hover", () => {
    const html = renderToString(
      <MessageRow avatar={<span data-testid="avatar" />} author="Maya" time="09:14" continued>
        Still going.
      </MessageRow>,
    );

    expect(html).toContain('data-continued="true"');
    expect(html).not.toContain('data-testid="avatar"');
    expect(html).not.toContain('data-slot="message-row-author"');
    expect(html).toContain('data-slot="message-row-time"');
    expect(html).toContain("group-hover:opacity-100");
  });
});
