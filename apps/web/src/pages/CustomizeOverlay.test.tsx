// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const mounts = vi.hoisted(() => ({ integrations: 0, skills: 0 }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("./PluginsOverlay", () => ({
  PluginsOverlay: () => {
    useEffect(() => {
      mounts.integrations += 1;
    }, []);
    return <p>integrations body</p>;
  },
}));
vi.mock("./SkillsOverlay", () => ({
  SkillsOverlay: () => {
    useEffect(() => {
      mounts.skills += 1;
    }, []);
    return <p>skills body</p>;
  },
}));

import { CustomizeOverlay } from "./CustomizeOverlay";

it("switches sections inside one dialog without remounting a visited section", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CustomizeOverlay onClose={() => {}} />));
  const click = (testId: string) =>
    act(async () => {
      document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
    });

  const dialog = document.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();
  expect(mounts).toEqual({ integrations: 1, skills: 0 });

  await click("customize-nav-skills");
  await click("customize-nav-integrations");
  await click("customize-nav-skills");

  expect(document.querySelector('[role="dialog"]')).toBe(dialog);
  expect(dialog?.querySelector("h2")?.textContent).toBe("Skills");
  expect(mounts).toEqual({ integrations: 1, skills: 1 });

  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
