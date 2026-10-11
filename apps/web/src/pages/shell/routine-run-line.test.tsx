import type { EntryId, SessionId } from "@rakazo/contracts";
import type { RoutineLineRun } from "@rakazo/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro/babel transform, so these macro imports must be
// mocked to a plain passthrough (same pattern as AskCard.test.tsx).
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({
  t: identityTag,
  plural: (count: number, forms: { one: string; other: string }) =>
    (count === 1 ? forms.one : forms.other).replace("#", String(count)),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

import { RoutineGroupLine, RoutineRunLine } from "./routine-run-line";

type Finished = NonNullable<RoutineLineRun["item"]["finished"]>;

function run(
  id: string,
  finished: Finished | null = { status: "completed", result: "" },
  latest = true,
): RoutineLineRun {
  return {
    item: {
      kind: "routine",
      id: id as EntryId,
      ts: "2026-09-27T10:00:00.000Z",
      runId: `run-${id}`,
      botId: "bot-1",
      sessionId: `session-${id}` as SessionId,
      routineId: "routine-1",
      name: "Surveillance Accor",
      finished,
    },
    latest,
  };
}

const open = () => undefined;

describe("RoutineRunLine", () => {
  it("opens the routine's session at once when it has no words to show", () => {
    const html = renderToStaticMarkup(<RoutineRunLine run={run("r1")} onOpen={open} />);

    expect(html).toContain("Surveillance Accor");
    expect(html).toContain("Completed");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("aria-expanded");
  });

  it("shows the failed word in the destructive colour and stays closed when it is not the latest run", () => {
    const html = renderToStaticMarkup(
      <RoutineRunLine run={run("r1", { status: "failed", result: "boom" }, false)} onOpen={open} />,
    );

    expect(html).toContain("Failed");
    expect(html).toContain("text-destructive");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("boom");
  });

  it("opens the routine's latest failed run on its words, which open the session", () => {
    const html = renderToStaticMarkup(
      <RoutineRunLine run={run("r1", { status: "failed", result: "boom" })} onOpen={open} />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("boom");
    expect(html).toContain('aria-label="Report, Surveillance Accor · Opens in full"');
  });

  it("opens a subscribed routine's latest run on its words and rings the bell", () => {
    const subscribed = (latest: boolean) => {
      const line = run("r1", { status: "completed", result: "All green" }, latest);
      return { ...line, item: { ...line.item, notify: true as const } };
    };
    const latest = renderToStaticMarkup(<RoutineRunLine run={subscribed(true)} onOpen={open} />);
    const older = renderToStaticMarkup(<RoutineRunLine run={subscribed(false)} onOpen={open} />);
    const quiet = renderToStaticMarkup(
      <RoutineRunLine
        run={run("r1", { status: "completed", result: "All green" })}
        onOpen={open}
      />,
    );

    expect(latest).toContain('aria-expanded="true"');
    expect(latest).toContain("All green");
    expect(latest).toContain('role="img" aria-label="Notifications on"');
    expect(latest).toContain('aria-label="Surveillance Accor, Completed, ');
    expect(older).toContain('aria-expanded="false"');
    expect(older).toContain('aria-label="Notifications on"');
    expect(quiet).toContain('aria-expanded="false"');
    expect(quiet).not.toContain("Notifications on");
  });

  it("says a run still in the queue is queued, without the shimmer", () => {
    const html = renderToStaticMarkup(
      <RoutineRunLine run={run("r1", null)} onOpen={open} queued />,
    );

    expect(html).toContain(">Queued<");
    expect(html).not.toContain("rk-shimmer");
    expect(html).toContain("lucide-clock");
  });

  it("shimmers the status word while the run is going", () => {
    const html = renderToStaticMarkup(<RoutineRunLine run={run("r1", null)} onOpen={open} />);

    expect(html).toContain("rk-shimmer");
    expect(html).toContain("Running");
  });
});

describe("RoutineGroupLine", () => {
  const handoffFor = () => undefined;

  it("names the routine and how many runs it holds, closed by default", () => {
    const runs = ["r1", "r2", "r3", "r4"].map((id) => run(id));
    const html = renderToStaticMarkup(
      <RoutineGroupLine runs={runs} handoffFor={handoffFor} onOpenRun={open} />,
    );

    expect(html).toContain("Surveillance Accor");
    expect(html).toContain("4 runs");
    expect(html).toContain("Completed");
    expect(html).toContain("text-success");
    expect(html).toContain('aria-expanded="false"');
  });

  it("says how many were cancelled instead of Completed when any run was", () => {
    const runs = [run("r1", { status: "cancelled", result: "" }), run("r2")];
    const html = renderToStaticMarkup(
      <RoutineGroupLine runs={runs} handoffFor={handoffFor} onOpenRun={open} />,
    );

    expect(html).toContain("1 cancelled");
    expect(html).not.toContain(">Completed<");
    // The icon says cancelled too, not a green check beside "1 cancelled".
    expect(html).not.toContain("text-success");
    expect(html).toContain("lucide-circle-stop");
  });
});
