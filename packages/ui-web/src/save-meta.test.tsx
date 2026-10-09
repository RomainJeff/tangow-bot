import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SaveMeta } from "./save-meta.js";

const labels = { saving: "Saving…", saved: "Saved", failed: "Could not save", retry: "Retry" };
const at = Date.UTC(2026, 9, 6, 14, 2);

describe("SaveMeta", () => {
  const timeZone = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    if (timeZone === undefined) delete process.env.TZ;
    else process.env.TZ = timeZone;
  });

  it("is an empty polite live region at rest, so the next change is announced", () => {
    const html = renderToString(<SaveMeta state={{ kind: "idle" }} labels={labels} />);
    expect(html).toContain('data-slot="save-meta"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toMatch(/<span[^>]*><\/span>$/);
  });

  it("says Saving… while the call runs", () => {
    const html = renderToString(
      <SaveMeta state={{ kind: "saving", value: "x", attempt: 1 }} labels={labels} />,
    );
    expect(html).toContain("Saving…");
  });

  it("shows the time of the save in the locale it is given", () => {
    const state = { kind: "saved", value: "x", at, until: at + 3000 } as const;
    expect(renderToString(<SaveMeta state={state} labels={labels} locale="en-GB" />)).toContain(
      "Saved 14:02",
    );
    expect(renderToString(<SaveMeta state={state} labels={labels} locale="fr-FR" />)).toContain(
      "Saved 14:02",
    );
    expect(
      renderToString(<SaveMeta state={state} labels={labels} locale="en-US" />).replace(
        /[  ]/g,
        " ",
      ),
    ).toContain("Saved 2:02 PM");
  });

  it("offers a Retry next to the failure and wires it to onRetry", () => {
    const html = renderToString(
      <SaveMeta
        state={{ kind: "failed", value: "x", reason: "", attempt: 1 }}
        labels={labels}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("Could not save");
    expect(html).toMatch(/<button type="button"[^>]*data-slot="button"[^>]*>Retry<\/button>/);
    expect(html).toContain("text-destructive");
  });

  it("says why next to Retry when the server gave a reason, and falls back to Could not save", () => {
    const failed = (reason: string) =>
      renderToString(
        <SaveMeta
          state={{ kind: "failed", value: true, reason, attempt: 1 }}
          labels={labels}
          onRetry={() => {}}
        />,
      ).replace(/<!-- -->/g, "");
    expect(failed("Add a run time for this one-shot.")).toMatch(
      /Add a run time for this one-shot\. · <button[^>]*>Retry<\/button>/,
    );
    expect(failed("Add a run time for this one-shot.")).not.toContain("Could not save");
    expect(failed("")).toMatch(/Could not save · <button[^>]*>Retry<\/button>/);
  });

  it("merges className and spreads native props", () => {
    const html = renderToString(
      <SaveMeta
        state={{ kind: "idle" }}
        labels={labels}
        className="ms-2"
        data-testid="meta"
        id="m"
      />,
    );
    expect(html).toContain("ms-2");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain('data-testid="meta"');
    expect(html).toContain('id="m"');
  });
});
