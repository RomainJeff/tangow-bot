import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FramedBlock } from "./framed-block.js";

describe("FramedBlock", () => {
  it("frames the question on the one elevated surface", () => {
    const html = renderToString(
      <FramedBlock
        header={{ who: "Maya needs your call", dot: true }}
        question="Send the recap to #ops?"
        consequence="They will see the last 12 messages."
        actions={<button type="button">Send</button>}
      />,
    );

    expect(html).toContain('data-slot="framed-block"');
    expect(html).toContain("rounded-block");
    expect(html).toContain("bg-surface");
    expect(html).toContain("shadow-card");
    expect(html).toContain("text-block-header");
    expect(html).toContain("text-question");
    expect(html).toContain('data-slot="framed-block-consequence"');
    expect(html).toContain('data-slot="framed-block-actions"');
    expect(html).not.toContain('data-answered="true"');
  });

  it("renders no header row when the row above already names who is asking", () => {
    const html = renderToString(
      <FramedBlock question="Which room?" actions={<button type="button">Send</button>} />,
    );
    expect(html).not.toContain('data-slot="framed-block-header"');
    expect(html).not.toContain("text-block-header");
    expect(html).toContain('data-slot="framed-block-question"');
  });

  it("hides the ink dot unless the block is waiting on someone", () => {
    const html = renderToString(
      <FramedBlock header={{ who: "Maya asked" }} question="Which room?" />,
    );
    expect(html).not.toContain("bg-foreground");
    expect(html).not.toContain('data-slot="framed-block-actions"');
  });

  it("settles once answered: no controls, no actions, just the answer", () => {
    const html = renderToString(
      <FramedBlock
        header={{ who: "Maya needs your call" }}
        question="Send the recap to #ops?"
        actions={<button type="button">Send</button>}
        answered="Answered: sent to #ops"
      >
        <input aria-label="Other room" />
      </FramedBlock>,
    );

    expect(html).toContain('data-answered="true"');
    expect(html).toContain('data-slot="framed-block-answered"');
    // Back on the bot's paper: the thread's one elevation is free again.
    expect(html).toContain("shadow-settled");
    expect(html).not.toContain("shadow-card");
    expect(html).toContain("text-meta");
    expect(html).not.toContain('data-slot="framed-block-actions"');
    expect(html).not.toContain('data-slot="framed-block-body"');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
  });

  it("lines the header up as icon, who, then a state at the end", () => {
    const html = renderToString(
      <FramedBlock
        header={{
          who: "Mail · ana@example.com",
          icon: <img alt="" src="logo.png" />,
          status: "Edited",
        }}
        question="To bo@example.com"
      />,
    );
    const header = html.slice(html.indexOf('data-slot="framed-block-header"'));
    expect(header.indexOf("logo.png")).toBeLessThan(header.indexOf("Mail · ana@example.com"));
    expect(header).toContain(
      '<span data-slot="framed-block-status" class="ms-auto shrink-0">Edited</span>',
    );
  });

  it("settles on its answer alone when there is no question to repeat", () => {
    const html = renderToString(<FramedBlock answered="Replaced" />);
    expect(html).not.toContain('data-slot="framed-block-question"');
    expect(html).toContain('data-slot="framed-block-answered"');
  });

  it("passes a className and the remaining props through", () => {
    const html = renderToString(
      <FramedBlock
        className="max-w-thread"
        data-testid="secret-ask-card"
        header={{ who: "Maya" }}
        question="Now?"
      />,
    );
    expect(html).toContain("max-w-thread");
    expect(html).toContain('data-testid="secret-ask-card"');
  });

  it("puts the actions on the right by default and keeps their order", () => {
    const html = renderToString(
      <FramedBlock
        question="Send the recap?"
        actions={
          <>
            <button type="button">Not now</button>
            <button type="button">Revise</button>
            <button type="button">Send</button>
          </>
        }
      />,
    );
    expect(html).toContain('data-slot="framed-block-actions" data-align="end"');
    expect(html).toContain("justify-end");
    expect(html.indexOf("Not now")).toBeLessThan(html.indexOf("Revise"));
    expect(html.indexOf("Revise")).toBeLessThan(html.indexOf("Send<"));
  });

  it("keeps a list of answers on the left", () => {
    const html = renderToString(
      <FramedBlock
        question="Which room?"
        actionsAlign="start"
        actions={<button type="button">Other answer…</button>}
      />,
    );
    expect(html).toContain('data-align="start"');
    expect(html).toContain("justify-start");
    expect(html).not.toContain("justify-end");
  });
});
