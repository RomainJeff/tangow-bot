// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  bots: { update: vi.fn(), setComputer: vi.fn() },
}));
vi.mock("../../lib/rpc", () => ({ rpc: api }));

import { type BotCommands, useBotCommands } from "./bot-commands";

function bot(id: string, name: string): Bot {
  return { id, name, instructions: "" } as Bot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let view: { bots: Bot[]; commands: BotCommands };
const invalidateBotsRefresh = vi.fn();

function Harness() {
  const [bots, setBots] = useState([bot("a", "Ada"), bot("b", "Bea")]);
  const commands = useBotCommands({ setBots, invalidateBotsRefresh, botAction: vi.fn() });
  view = { bots, commands };
  return null;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const names = () => view.bots.map((item) => item.name);

it("merges the bot a write returns into the roster by id, leaving the others alone", async () => {
  const bea = view.bots[1];
  api.bots.update.mockResolvedValueOnce(bot("a", "Ada Lovelace"));

  await act(() => view.commands.updateBot("a", { name: "Ada Lovelace" }));

  expect(api.bots.update).toHaveBeenCalledWith({ botId: "a", name: "Ada Lovelace" });
  expect(names()).toEqual(["Ada Lovelace", "Bea"]);
  expect(view.bots[1]).toBe(bea);
  expect(invalidateBotsRefresh).toHaveBeenCalledTimes(1);
});

it("never lets an older answer for a bot overwrite a newer one", async () => {
  const slow = deferred<Bot>();
  api.bots.update.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(bot("a", "Second"));

  const first = view.commands.updateBot("a", { name: "First" });
  await act(() => view.commands.updateBot("a", { name: "Second" }));
  slow.resolve(bot("a", "First"));
  await act(() => first);

  expect(names()).toEqual(["Second", "Bea"]);
});

it("keeps both of two quick writes when the server answered them in reverse", async () => {
  const nameWrite = deferred<Bot>();
  api.bots.update
    .mockReturnValueOnce(nameWrite.promise)
    .mockResolvedValueOnce({ ...bot("a", "Ada"), title: "Reads the news" });

  const naming = view.commands.updateBot("a", { name: "Ada 2" });
  await act(() => view.commands.updateBot("a", { title: "Reads the news" }));
  // The server applied the title first, so the name's answer is the newest row.
  nameWrite.resolve({ ...bot("a", "Ada 2"), title: "Reads the news" });
  await act(() => naming);

  expect(view.bots[0]).toMatchObject({ name: "Ada 2", title: "Reads the news" });
});

it("still applies an answer for another bot that arrives late", async () => {
  const slow = deferred<Bot>();
  api.bots.update.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(bot("a", "Ada 2"));

  const forBea = view.commands.updateBot("b", { name: "Bea 2" });
  await act(() => view.commands.updateBot("a", { name: "Ada 2" }));
  slow.resolve(bot("b", "Bea 2"));
  await act(() => forBea);

  expect(names()).toEqual(["Ada 2", "Bea 2"]);
});

it("sends the computer on its own call and merges what it returns", async () => {
  api.bots.setComputer.mockResolvedValueOnce({ ...bot("a", "Ada"), computerMode: "dedicated" });

  await act(() => view.commands.setComputer("a", "dedicated"));

  expect(api.bots.setComputer).toHaveBeenCalledWith({ botId: "a", mode: "dedicated" });
  expect(api.bots.update).not.toHaveBeenCalled();
  expect(view.bots[0]).toMatchObject({ computerMode: "dedicated" });
});
