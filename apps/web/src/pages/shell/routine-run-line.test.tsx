import type { MessageBlock } from "@rakazo/contracts";
import type { RoutineGroupRun } from "@rakazo/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// vitest doesn't run the lingui macro/babel transform, so these macro imports must be
// mocked to a plain passthrough (same pattern as AskCard.test.tsx).
function identityTag(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, part, index) => `${acc}${part}${values[index] ?? ""}`, "");
}
vi.mock("@lingui/core/macro", () => ({ t: identityTag }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: identityTag }),
  Trans: ({ children }: { children?: unknown }) => children,
}));

import { GROUP_DIALOG_MAX, RoutineGroupLine, RoutineRunLine } from "./routine-run-line";

type RoutineRunBlock = Extract<MessageBlock, { kind: "routine_run" }>;

function run(overrides: Partial<RoutineRunBlock> & { routineName: string }): RoutineRunBlock {
  return { kind: "routine_run", state: "completed", ...overrides } as RoutineRunBlock;
}

function item(overrides: Partial<RoutineGroupRun> & { run: RoutineRunBlock }): RoutineGroupRun {
  return { messageId: "m1", createdAt: "2026-09-27T10:00:00.000Z", ...overrides };
}

describe("RoutineRunLine", () => {
  it("is not a button when it carries neither a report nor a handoff (edge case)", () => {
    const html = renderToStaticMarkup(
      <RoutineRunLine item={item({ run: run({ routineName: "Surveillance Accor" }) })} />,
    );

    expect(html).not.toContain("<button");
    expect(html).toContain("Surveillance Accor");
    expect(html).toContain("Completed");
  });

  it("shows the failed word in the destructive colour and stays closed when it is not the latest run", () => {
    const html = renderToStaticMarkup(
      <RoutineRunLine
        item={item({
          run: run({ routineName: "Surveillance Accor", state: "failed", digest: "boom" }),
          latest: false,
        })}
      />,
    );

    expect(html).toContain("Failed");
    expect(html).toContain("text-destructive");
    expect(html).toContain('aria-expanded="false"');
  });

  it("auto-opens the routine's latest run when it failed or is subscribed (A5)", () => {
    const html = renderToStaticMarkup(
      <RoutineRunLine
        item={item({
          run: run({ routineName: "Surveillance Accor", state: "failed", digest: "boom" }),
          latest: true,
        })}
      />,
    );

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("border-outline");
    expect(html).toContain("boom");
  });

  it("shows a bell with an accessible name when subscribed", () => {
    const html = renderToStaticMarkup(
      <RoutineRunLine
        item={item({ run: run({ routineName: "Surveillance Accor", notify: true }) })}
      />,
    );

    expect(html).toContain('aria-label="Notifications on"');
  });

  it("shimmers the status word while the run is going", () => {
    const html = renderToStaticMarkup(
      <RoutineRunLine
        item={item({ run: run({ routineName: "Surveillance Accor", state: "running" }) })}
      />,
    );

    expect(html).toContain("rk-shimmer");
    expect(html).toContain("Running");
  });
});

describe("RoutineGroupLine", () => {
  const handoffFor = () => undefined;

  it("names the routine and how many runs it holds, closed by default", () => {
    const runs = [
      item({ messageId: "r1", run: run({ routineName: "Surveillance Accor" }) }),
      item({ messageId: "r2", run: run({ routineName: "Surveillance Accor" }) }),
      item({ messageId: "r3", run: run({ routineName: "Surveillance Accor" }) }),
      item({ messageId: "r4", run: run({ routineName: "Surveillance Accor" }) }),
    ];
    const html = renderToStaticMarkup(<RoutineGroupLine runs={runs} handoffFor={handoffFor} />);

    expect(html).toContain("Surveillance Accor");
    expect(html).toContain("4 runs");
    expect(html).toContain("Completed");
    expect(html).toContain('aria-expanded="false"');
  });

  it("says how many were cancelled instead of Completed when any run was", () => {
    const runs = [
      item({
        messageId: "r1",
        run: run({ routineName: "Surveillance Accor", state: "cancelled" }),
      }),
      item({ messageId: "r2", run: run({ routineName: "Surveillance Accor" }) }),
    ];
    const html = renderToStaticMarkup(<RoutineGroupLine runs={runs} handoffFor={handoffFor} />);

    expect(html).toContain("1 cancelled");
    expect(html).not.toContain(">Completed<");
  });

  it("caps the inline list at GROUP_DIALOG_MAX runs (A8c)", () => {
    expect(GROUP_DIALOG_MAX).toBe(8);
    const runs = Array.from({ length: 9 }, (_, i) =>
      item({ messageId: `r${i}`, run: run({ routineName: "Surveillance Accor" }) }),
    );
    const html = renderToStaticMarkup(<RoutineGroupLine runs={runs} handoffFor={handoffFor} />);
    // Closed by default either way; the dialog-vs-inline choice only shows once
    // opened, which needs a click a static render can't simulate — this only
    // pins the threshold constant used to decide it.
    expect(html).toContain("9 runs");
  });
});
