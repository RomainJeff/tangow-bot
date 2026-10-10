// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const list = vi.hoisted(() => vi.fn());
vi.mock("../../lib/rpc", () => ({ rpc: { agentSkills: { list } } }));

import { useAgentSkillCatalog } from "./agent-skill-catalog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("keeps the newest catalog when an older read answers last", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const entry = (name: string) => ({ id: `user:${name}`, name });
  const initial = deferred<unknown[]>();
  const beforeDelete = deferred<unknown[]>();
  const afterDelete = deferred<unknown[]>();
  list
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(beforeDelete.promise)
    .mockReturnValueOnce(afterDelete.promise);
  const activeBotId = { current: "bot-fixture" };
  let view: { names: string[]; refresh: () => void } | undefined;
  function Harness() {
    const [skills, refresh] = useAgentSkillCatalog(activeBotId);
    view = { names: skills.map((skill) => skill.name), refresh };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness />));
    await act(async () => initial.resolve([entry("greet-politely"), entry("review")]));
    expect(view?.names).toEqual(["greet-politely", "review"]);

    await act(async () => view?.refresh());
    await act(async () => view?.refresh());
    await act(async () => afterDelete.resolve([entry("review")]));
    await act(async () => beforeDelete.resolve([entry("greet-politely"), entry("review")]));
    expect(view?.names).toEqual(["review"]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
