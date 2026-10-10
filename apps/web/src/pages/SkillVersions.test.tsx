// @vitest-environment jsdom

import { ORPCError } from "@orpc/client";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn(), versions: vi.fn(), undo: vi.fn() }));
vi.mock("../lib/rpc", () => ({ rpc: { agentSkills: api } }));
vi.mock("../components/ArtifactFileCard", () => ({ formatBytes: () => "" }));
vi.mock("./RecentlyDeleted", () => ({ RecentlyDeleted: () => null }));
vi.mock("./bot-page/page-kit", () => ({ LoadingRows: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
  };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
    cn: (...names: unknown[]) => names.filter(Boolean).join(" "),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: Container,
    NativeSelectOptGroup: Container,
    NativeSelectOption: Container,
    SettingRow: ({ label }: { label: ReactNode }) => <div>{label}</div>,
    Surface: Container,
    Switch: () => null,
  };
});

import { AgentSkillEditor } from "./KnowledgeSection";

const content = "---\nname: greeting\ndescription: Greet politely\n---\nHello";
const skill = (id: string, body = content) => ({
  id,
  name: "greeting",
  description: "Greet politely",
  content: body,
  availability: "all",
  visibleBotIds: [],
  source: "user",
});
const version = (versionId: string, current: boolean) => ({
  versionId,
  createdAt: "2026-10-09T08:05:00.000Z",
  author: { kind: "user" },
  nature: "modified",
  current,
  undone: false,
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.get.mockReset().mockResolvedValue(skill("skill-a"));
  api.versions.mockReset().mockResolvedValue([version("v2", true), version("v1", false)]);
  api.undo.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const undoButton = () =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === "Undo")!;
const textarea = () => container.querySelector("textarea")!;

it("follows the skill to its old id when Undo takes back a rename", async () => {
  api.undo.mockResolvedValue({ kind: "restored", skillId: "skill-old-name", name: "greeting" });
  const onSkillChange = vi.fn();
  await act(async () =>
    root.render(
      <AgentSkillEditor skillId="skill-a" onDone={() => {}} onSkillChange={onSkillChange} />,
    ),
  );
  await act(async () => undoButton().click());
  expect(api.undo.mock.calls).toEqual([[{ skillId: "skill-a", expectedVersionId: "v2" }]]);
  expect(onSkillChange.mock.calls).toEqual([["skill-old-name"]]);
});

it("holds Undo while the editor has unsaved edits", async () => {
  await act(async () => root.render(<AgentSkillEditor skillId="skill-a" onDone={() => {}} />));
  const type = (value: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea(),
      value,
    );
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  };
  expect(undoButton().disabled).toBe(false);
  await act(async () => type(`${content} there`));
  expect(undoButton().disabled).toBe(true);
  await act(async () => type(content));
  expect(undoButton().disabled).toBe(false);
});

it("reads the skill again when Undo is refused, keeping the reason on screen", async () => {
  api.undo.mockRejectedValue(
    new ORPCError("CONFLICT", { message: "This skill changed. Reload and try again." }),
  );
  await act(async () => root.render(<AgentSkillEditor skillId="skill-a" onDone={() => {}} />));
  expect(textarea().value).toBe(content);
  api.get.mockResolvedValue(skill("skill-a", `${content} from the bot`));
  await act(async () => undoButton().click());
  expect(textarea().value).toBe(`${content} from the bot`);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "This skill changed. Reload and try again.",
  );
});
