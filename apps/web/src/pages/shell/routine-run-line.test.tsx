import type { EntryId, SessionId } from "@rakazo/contracts";
import type { RoutineItem, RoutineLineRun } from "@rakazo/core";
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
  useLingui: () => ({ t: identityTag, i18n: { locale: "en-GB" } }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

import { RoutineFailureLine, RoutineGroupLine, RoutineRunLine } from "./routine-run-line";

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

function failure(id: string, ts: string, failure: "provider" | "other" = "provider"): RoutineItem {
  return {
    kind: "routine",
    id: id as EntryId,
    ts,
    runId: `run-${id}`,
    botId: "bot-1",
    sessionId: `session-${id}` as SessionId,
    routineId: "routine-1",
    name: "Grocery budget",
    finished: { status: "failed", result: "", failure },
  };
}

const open = () => undefined;
const local = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();

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

describe("RoutineFailureLine", () => {
  it("names the routine and why it failed, without a count for one failure", () => {
    const html = renderToStaticMarkup(
      <RoutineFailureLine
        item={failure("a", local(12, 7))}
        count={1}
        since={local(12, 7)}
        onOpen={open}
      />,
    );
    expect(html).toContain("Grocery budget<span");
    expect(html).toContain("· Model error");
    expect(html).not.toContain("since");
  });

  it("still says the run failed to a screen reader when there is no reason to show", () => {
    const html = renderToStaticMarkup(
      <RoutineFailureLine
        item={failure("a", local(12, 7), "other")}
        count={1}
        since={local(12, 7)}
        onOpen={open}
      />,
    );
    expect(html).toContain('Grocery budget<span class="sr-only">, Failed</span>');
  });

  it("counts folded failures from the first one's time, with its day when it is another day", () => {
    const sameDay = renderToStaticMarkup(
      <RoutineFailureLine
        item={failure("c", local(12, 9))}
        count={3}
        since={local(12, 7)}
        onOpen={open}
      />,
    );
    const acrossDays = renderToStaticMarkup(
      <RoutineFailureLine
        item={failure("b", local(13, 9), "other")}
        count={2}
        since={local(12, 7)}
        onOpen={open}
      />,
    );
    expect(sameDay).toContain(">3 failures since 07:00<");
    expect(acrossDays).toContain(">2 failures since Mon 07:00<");
    expect(acrossDays).not.toContain("·");
  });
});
