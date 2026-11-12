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

function stubPhone(phone: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: phone,
    media,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

it("switches sections inside one dialog without remounting a visited section", async () => {
  stubPhone(false);
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

it("opens a phone on the list of sections and returns to it from a section", async () => {
  stubPhone(true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CustomizeOverlay onClose={() => {}} />));
  const click = (selector: string) =>
    act(async () => {
      document.querySelector<HTMLButtonElement>(selector)?.click();
    });
  const title = () => document.querySelector("h2")?.textContent;

  expect(title()).toBe("Customize");
  expect(document.querySelector('[data-testid="customize-nav-skills"]')).toBeNull();

  await click('[data-testid="customize-list-skills"]');
  expect(title()).toBe("Skills");

  const back = [...document.querySelectorAll("button")].find((b) => b.textContent === "Customize");
  expect(document.activeElement).toBe(back);
  await act(async () => back?.click());
  expect(title()).toBe("Customize");
  expect(document.activeElement).toBe(
    document.querySelector('[data-testid="customize-list-skills"]'),
  );

  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
