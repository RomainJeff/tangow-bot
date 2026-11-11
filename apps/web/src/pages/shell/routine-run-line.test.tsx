import type { EntryId, SessionId } from "@tangow/contracts";
import type { RoutineItem } from "@tangow/core";
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

import { RoutineFailureLine } from "./routine-run-line";

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
