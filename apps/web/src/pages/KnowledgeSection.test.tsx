// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { agentSkills: api, bots: { list: async () => [] } },
}));
vi.mock("../components/ArtifactFileCard", () => ({ formatBytes: () => "" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button {...props} />
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: ({ size: _size, ...props }: ComponentProps<"select"> & { size?: string }) => (
      <select {...props} />
    ),
    NativeSelectOptGroup: Container,
    NativeSelectOption: ({ children, ...props }: ComponentProps<"option">) => (
      <option {...props}>{children}</option>
    ),
    Switch: ({
      onCheckedChange: _onCheckedChange,
      ...props
    }: ComponentProps<"input"> & { onCheckedChange?: (checked: boolean) => void }) => (
      <input type="checkbox" {...props} />
    ),
  };
});

import { AgentSkills } from "./KnowledgeSection";

it("disables skill rows while a completed save is refreshing the catalog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const skill = {
    id: "skill-fixture",
    name: "greeting",
    description: "Greet politely",
    content: "Hello",
    availability: "all",
    visibleBotIds: [],
    source: "user",
  };
  let finishRefresh!: (value: (typeof skill)[]) => void;
  const refresh = new Promise<(typeof skill)[]>((resolve) => {
    finishRefresh = resolve;
  });
  api.list.mockResolvedValueOnce([skill]).mockReturnValueOnce(refresh);
  api.create.mockResolvedValue(skill);
  api.get.mockResolvedValue(skill);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await act(async () => root.render(<AgentSkills botId="bot-fixture" />));
    await act(async () => button("New skill").click());
    await act(async () => button("Save").click());
    expect(api.create).toHaveBeenCalledOnce();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(button("greeting").disabled).toBe(true);
    await act(async () => button("greeting").click());
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => finishRefresh([skill]));
    expect(button("greeting").disabled).toBe(false);
    await act(async () => button("greeting").click());
    expect(container.querySelector("textarea")?.value).toBe("Hello");
  } finally {
    await act(async () => {
      finishRefresh([skill]);
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("tells the shell a skill is gone only once the server has deleted it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const skill = {
    id: "user:greet-politely",
    name: "greet-politely",
    description: "Say hello",
    content: "Hello",
    availability: "all",
    visibleBotIds: ["bot-fixture"],
    source: "user",
  };
  let server = [skill];
  api.list.mockImplementation(async () => server);
  api.get.mockResolvedValue(skill);
  api.remove.mockImplementation(async ({ skillId }: { skillId: string }) => {
    await Promise.resolve();
    server = server.filter((entry) => entry.id !== skillId);
  });
  const seenOnChange: string[][] = [];
  const onChanged = () => {
    seenOnChange.push(server.map((entry) => entry.name));
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === text || entry.textContent?.startsWith(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  try {
    await act(async () => root.render(<AgentSkills botId="bot-fixture" onChanged={onChanged} />));
    await act(async () => button("greet-politely").click());
    await act(async () => button("Delete").click());
    expect(seenOnChange).toEqual([]);
    await act(async () => button("Confirm delete").click());
    expect(seenOnChange).toEqual([[]]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
