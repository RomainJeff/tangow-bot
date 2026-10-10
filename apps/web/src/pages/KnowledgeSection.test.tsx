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
const updateMemory = vi.hoisted(() => vi.fn());
vi.mock("../lib/rpc", () => ({
  rpc: {
    agentSkills: api,
    bots: { list: async () => [] },
    memory: { update: updateMemory },
  },
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

import { AgentSkills, MemoryDocumentList } from "./KnowledgeSection";

async function mount(node: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes(text),
    );
    if (!found) throw new Error(`Missing button: ${text}`);
    return found;
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  };
  return { container, button, unmount };
}

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

it("hands a skill and a new one to onOpenEditor instead of editing in the list", async () => {
  api.list.mockResolvedValue([
    {
      id: "skill-fixture",
      name: "greeting",
      description: "Greet politely",
      availability: "all",
      visibleBotIds: [],
      source: "user",
    },
  ]);
  const onOpenEditor = vi.fn();
  const view = await mount(<AgentSkills botId="bot-fixture" onOpenEditor={onOpenEditor} />);
  try {
    await act(async () => view.button("greeting").click());
    await act(async () => view.button("New skill").click());
    expect(onOpenEditor.mock.calls).toEqual([["skill-fixture"], [null]]);
    expect(view.container.querySelector("textarea")).toBeNull();
  } finally {
    await view.unmount();
  }
});

it("holds the other memory rows while an inline save runs", async () => {
  const doc = (id: string, path: string) => ({
    id,
    scope: "user" as const,
    botId: null,
    path,
    content: `# ${path}`,
    revision: 1,
    updatedAt: "2026-10-10T08:00:00.000Z",
  });
  let finishSave!: () => void;
  updateMemory.mockImplementation(
    ({ documentId, content }: { documentId: string; content: string }) =>
      new Promise((resolve) => {
        finishSave = () => resolve({ ...doc(documentId, "MEMORY.md"), content, revision: 2 });
      }),
  );
  const view = await mount(
    <MemoryDocumentList
      load={async () => [doc("doc-1", "MEMORY.md"), doc("doc-2", "people.md")]}
      exportFilename="memory.md"
      emptyLabel="Nothing remembered yet"
      testId="memory"
    />,
  );
  try {
    await act(async () => view.button("MEMORY.md").click());
    const editor = view.container.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    act(() => {
      setValue?.call(editor, "# MEMORY.md\n\nShort answers.");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => view.button("Save").click());
    expect(view.button("people.md").disabled).toBe(true);
    await act(async () => finishSave());
    expect(view.button("people.md").disabled).toBe(false);
    expect(view.button("MEMORY.md").textContent).toBe("MEMORY.mdrev 2");
    expect(view.container.querySelector("textarea")).toBeNull();
  } finally {
    await view.unmount();
  }
});
