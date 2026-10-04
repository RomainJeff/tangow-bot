// @vitest-environment jsdom

import type { Bot } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../../lib/rpc", () => ({
  rpc: {
    computer: { status: api.status },
    voice: { voices: async () => [] },
    models: { credentials: async () => [], list: async () => [] },
    me: async () => ({}),
  },
}));
vi.mock("../ScratchpadSection", () => ({ ScratchpadSection: () => null }));
vi.mock("../KnowledgeSection", () => ({
  KnowledgeSection: () => null,
  BotSkillsSection: () => null,
}));
vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    BotAvatar: () => null,
    Button: ({ variant: _variant, ...props }: ComponentProps<"button"> & { variant?: string }) => (
      <button type="button" {...props} />
    ),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
    NativeSelectOption: ({ children, ...props }: ComponentProps<"option">) => (
      <option {...props}>{children}</option>
    ),
    Popover: Container,
    PopoverContent: Container,
    PopoverTrigger: Container,
    Switch: () => null,
    Textarea: (props: ComponentProps<"textarea">) => <textarea {...props} />,
    Toggle: Container,
    useAvatarStyle: () => "organic",
  };
});

import { BotSettings } from "./bot-panel";

const bot = {
  id: "bot-fixture",
  name: "Chief",
  title: "",
  description: "",
  instructions: "",
  color: "#000000",
  shapeSeed: null,
  notifyOnFinish: true,
  status: "idle",
  computerMode: "dedicated",
  memoryScope: null,
  autoSpeak: false,
  chattyReplies: false,
  voiceId: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  harness: "default",
} as unknown as Bot;

it("re-reads harness availability once a save lands", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.status
    .mockResolvedValueOnce({ nativeHarnesses: { "codex-native": false, "claude-native": false } })
    .mockResolvedValueOnce({ nativeHarnesses: { "codex-native": true, "claude-native": false } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const codex = () => container.querySelector<HTMLOptionElement>('option[value="codex-native"]');
  try {
    await act(async () =>
      root.render(
        <BotSettings
          bot={bot}
          memoryProviderConfigured={false}
          onSave={async () => undefined}
          onExport={async () => undefined}
          onClear={() => undefined}
        />,
      ),
    );
    expect(codex()?.disabled).toBe(true);
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save",
    );
    await act(async () => save?.click());
    expect(api.status).toHaveBeenCalledTimes(2);
    expect(codex()?.disabled).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
