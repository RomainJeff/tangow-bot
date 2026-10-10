// @vitest-environment jsdom
import type { Bot, Routine } from "@rakazo/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  bots: { update: vi.fn(), setComputer: vi.fn() },
  routines: { create: vi.fn(), update: vi.fn(), remove: vi.fn() },
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

function routine(id: string, name: string, botId = "a"): Routine {
  return { id, botId, name } as Routine;
}

let view: { bots: Bot[]; routines: Routine[]; commands: BotCommands };
const supersedeBotsRefresh = vi.fn();
const activeBotId = { current: "a" as string | undefined };
const navigate = vi.fn();
const closePanel = vi.fn();
const panelCoversThread = { current: false };

function Harness() {
  const [bots, setBots] = useState([bot("a", "Ada"), bot("b", "Bea")]);
  const [routines, setRoutines] = useState([routine("r-1", "Morning"), routine("r-2", "Evening")]);
  const commands = useBotCommands({
    setBots,
    setRoutines,
    activeBotId,
    supersedeBotsRefresh,
    botAction: vi.fn(),
    refreshThread: vi.fn(async () => undefined),
    navigate,
    panelCoversThread,
    closePanel,
    activityEpoch: 0,
    refreshSkills: vi.fn(),
  });
  view = { bots, routines, commands };
  return null;
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  activeBotId.current = "a";
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("opens a run on the message that started it, closing the panel only if it hides the thread", () => {
  panelCoversThread.current = false;
  view.commands.openRun({ botId: "a", groupId: null, sourceMessageId: "m-7" });
  expect(navigate).toHaveBeenCalledWith({ pathname: "/app/a", search: "?m=m-7" });
  expect(closePanel).not.toHaveBeenCalled();

  panelCoversThread.current = true;
  view.commands.openRun({ botId: "a", groupId: null, sourceMessageId: "m-8" });
  expect(navigate).toHaveBeenLastCalledWith({ pathname: "/app/a", search: "?m=m-8" });
  expect(closePanel).toHaveBeenCalledTimes(1);
});

const names = () => view.bots.map((item) => item.name);

it("merges the bot a write returns into the roster by id, leaving the others alone", async () => {
  const bea = view.bots[1];
  api.bots.update.mockResolvedValueOnce(bot("a", "Ada Lovelace"));

  await act(() => view.commands.updateBot("a", { name: "Ada Lovelace" }));

  expect(api.bots.update).toHaveBeenCalledWith({ botId: "a", name: "Ada Lovelace" });
  expect(names()).toEqual(["Ada Lovelace", "Bea"]);
  expect(view.bots[1]).toBe(bea);
  expect(supersedeBotsRefresh).toHaveBeenCalledTimes(1);
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

const routineNames = () => view.routines.map((item) => item.name);

it("merges the routine a write returns into the open bot's routines by id", async () => {
  const evening = view.routines[1];
  api.routines.update.mockResolvedValueOnce(routine("r-1", "Dawn"));

  await act(() => view.commands.updateRoutine("a", "r-1", { name: "Dawn" }));

  expect(api.routines.update).toHaveBeenCalledWith({ routineId: "r-1", name: "Dawn" });
  expect(routineNames()).toEqual(["Dawn", "Evening"]);
  expect(view.routines[1]).toBe(evening);
});

it("never lets an older routine answer overwrite a newer one", async () => {
  const slow = deferred<Routine>();
  api.routines.update
    .mockReturnValueOnce(slow.promise)
    .mockResolvedValueOnce(routine("r-1", "Second"));

  const first = view.commands.updateRoutine("a", "r-1", { name: "First" });
  await act(() => view.commands.updateRoutine("a", "r-1", { name: "Second" }));
  slow.resolve(routine("r-1", "First"));
  await act(() => first);

  expect(routineNames()).toEqual(["Second", "Evening"]);
});

it("leaves the routines alone when the answer comes after a switch to another bot", async () => {
  const slow = deferred<Routine>();
  api.routines.update.mockReturnValueOnce(slow.promise);

  const write = view.commands.updateRoutine("a", "r-1", { name: "Late" });
  activeBotId.current = "b";
  slow.resolve(routine("r-1", "Late"));
  await act(() => write);

  expect(routineNames()).toEqual(["Morning", "Evening"]);
});

it("does not bring back a removed routine when an earlier write lands after", async () => {
  const slow = deferred<Routine>();
  api.routines.update.mockReturnValueOnce(slow.promise);
  api.routines.remove.mockResolvedValueOnce({ ok: true });

  const write = view.commands.updateRoutine("a", "r-1", { name: "Late" });
  await act(() => view.commands.removeRoutine("a", "r-1"));
  slow.resolve(routine("r-1", "Late"));
  await act(() => write);

  expect(routineNames()).toEqual(["Evening"]);
});

it("creates a routine in the device's timezone and lists it last", async () => {
  api.routines.create.mockResolvedValueOnce(routine("r-3", "Weekly"));
  const payload = {
    name: "Weekly",
    prompt: "Sum up the week.",
    crons: ["0 9 * * 1"],
    active: true,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: true,
  };

  await act(() => view.commands.createRoutine("a", payload));

  expect(api.routines.create).toHaveBeenCalledWith({
    botId: "a",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...payload,
  });
  expect(routineNames()).toEqual(["Morning", "Evening", "Weekly"]);
});
