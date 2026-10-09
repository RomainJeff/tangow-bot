// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SegmentedControl } from "./segmented-control.js";

let container: HTMLElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => container.remove());

const OPTIONS = [
  { value: "team", label: "Team" },
  { value: "dedicated", label: "Private" },
] as const;

function Choice({ changes }: { changes: string[] }) {
  const [value, setValue] = useState<"team" | "dedicated">("dedicated");
  return (
    <SegmentedControl
      aria-label="Computer"
      value={value}
      options={OPTIONS}
      onValueChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
    />
  );
}

const pressed = () =>
  Array.from(container.querySelectorAll("button")).map(
    (button) => `${button.textContent}:${button.getAttribute("aria-pressed")}`,
  );

it("is one pressed segment that moves to the one chosen, and ignores the one already chosen", () => {
  const changes: string[] = [];
  const root = createRoot(container);
  act(() => root.render(<Choice changes={changes} />));
  expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Computer");
  expect(pressed()).toEqual(["Team:false", "Private:true"]);

  const [team, own] = Array.from(container.querySelectorAll("button")) as [
    HTMLButtonElement,
    HTMLButtonElement,
  ];
  act(() => own.click());
  expect(changes).toEqual([]);
  expect(pressed()).toEqual(["Team:false", "Private:true"]);

  act(() => team.click());
  expect(changes).toEqual(["team"]);
  expect(pressed()).toEqual(["Team:true", "Private:false"]);
  act(() => root.unmount());
});
