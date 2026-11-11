// @vitest-environment jsdom
import type { Bot, Routine } from "@tangow/contracts";
import type { RoutinePayload } from "@tangow/core";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  bots: { update: vi.fn(), setComputer: vi.fn(), get: vi.fn() },
  routines: { create: vi.fn(), update: vi.fn(), remove: vi.fn(), list: vi.fn() },
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

let view: {
  bots: Bot[];
  routines: Routine[];
  routinesBotId: string | null;
  commands: BotCommands;
};
const supersedeBotsRefresh = vi.fn();
const activeBotId = { current: "a" as string | undefined };
const navigate = vi.fn();
const closePanel = vi.fn();
const panelCoversThread = { current: false };

function Harness() {
  const [bots, setBots] = useState([bot("a", "Ada"), bot("b", "Bea")]);
  const [routines, setRoutines] = useState([routine("r-1", "Morning"), routine("r-2", "Evening")]);
  const [routinesBotId, setRoutinesBotId] = useState<string | null>(null);
  const commands = useBotCommands({
    setBots,
    setRoutines,
    setRoutinesBotId,
    activeBotId,
    supersedeBotsRefresh,
    botAction: vi.fn(),
    refreshThread: vi.fn(async () => undefined),
    navigate,
    panelCoversThread,
    closePanel,
    viewRun: vi.fn(),
    activityEpoch: 0,
    refreshSkills: vi.fn(),
  });
  view = { bots, routines, routinesBotId, commands };
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

it("reads the open bot and its routines again, in the order the server lists them", async () => {
  api.bots.get.mockResolvedValueOnce(bot("a", "Ada, renamed elsewhere"));
  api.routines.list.mockResolvedValueOnce([routine("r-2", "Evening"), routine("r-4", "Night")]);

  await act(() => view.commands.refresh("a"));

  expect(names()).toEqual(["Ada, renamed elsewhere", "Bea"]);
  expect(routineNames()).toEqual(["Evening", "Night"]);
  expect(view.routinesBotId).toBe("a");
});

it("keeps a routine created while a refresh was reading the list", async () => {
  const list = deferred<Routine[]>();
  api.bots.get.mockResolvedValueOnce(bot("a", "Ada"));
  api.routines.list.mockReturnValueOnce(list.promise);
  api.routines.create.mockResolvedValueOnce(routine("r-3", "Weekly"));

  const refreshing = view.commands.refresh("a");
  await act(() => view.commands.createRoutine("a", { name: "Weekly" } as RoutinePayload));
  list.resolve([routine("r-1", "Morning"), routine("r-2", "Evening")]);
  await act(() => refreshing);

  expect(routineNames()).toEqual(["Morning", "Evening", "Weekly"]);
});

it("lets only the newest of two refreshes set the routines", async () => {
  const older = deferred<Routine[]>();
  api.bots.get.mockResolvedValue(bot("a", "Ada"));
  api.routines.list
    .mockReturnValueOnce(older.promise)
    .mockResolvedValueOnce([routine("r-2", "Evening")]);

  const first = view.commands.refresh("a");
  await act(() => view.commands.refresh("a"));
  // Read before Morning was removed and Draft created then removed elsewhere.
  older.resolve([routine("r-1", "Morning"), routine("r-2", "Evening"), routine("r-9", "Draft")]);
  await act(() => first);

  expect(routineNames()).toEqual(["Evening"]);
});

it("keeps what writes sent before a refresh answered while it was reading", async () => {
  const read = deferred<Bot>();
  const list = deferred<Routine[]>();
  const rename = deferred<Bot>();
  const pause = deferred<Routine>();
  const removal = deferred<{ ok: true }>();
  api.bots.get.mockReturnValueOnce(read.promise);
  api.routines.list.mockReturnValueOnce(list.promise);
  api.bots.update.mockReturnValueOnce(rename.promise);
  api.routines.update.mockReturnValueOnce(pause.promise);
  api.routines.remove.mockReturnValueOnce(removal.promise);

  const writes = [
    view.commands.updateBot("a", { name: "Ada Lovelace" }),
    view.commands.updateRoutine("a", "r-2", { active: false }),
    view.commands.removeRoutine("a", "r-1"),
  ];
  const refreshing = view.commands.refresh("a");
  rename.resolve(bot("a", "Ada Lovelace"));
  pause.resolve({ ...routine("r-2", "Evening"), active: false });
  removal.resolve({ ok: true });
  await act(() => Promise.all(writes));
  // The server read every row before those writes landed.
  read.resolve(bot("a", "Ada"));
  list.resolve([routine("r-1", "Morning"), { ...routine("r-2", "Evening"), active: true }]);
  await act(() => refreshing);

  expect(names()).toEqual(["Ada Lovelace", "Bea"]);
  expect(view.routines.map((item) => [item.id, item.active])).toEqual([["r-2", false]]);
});

it("rejects when a read fails, leaving what is shown", async () => {
  api.bots.get.mockResolvedValueOnce(bot("a", "Ada"));
  api.routines.list.mockRejectedValueOnce(new Error("offline"));

  await act(() => expect(view.commands.refresh("a")).rejects.toThrow("offline"));

  expect(routineNames()).toEqual(["Morning", "Evening"]);
  expect(view.routinesBotId).toBe(null);
});

it("keeps a routine switched while a run end was reading the routines", async () => {
  const list = deferred<Routine[]>();
  api.routines.list.mockReturnValueOnce(list.promise);
  api.routines.update.mockResolvedValueOnce({ ...routine("r-1", "Morning"), active: false });

  const reading = view.commands.refreshRoutines("a");
  await act(() => view.commands.updateRoutine("a", "r-1", { active: false }));
  // The server read the list before the switch landed.
  list.resolve([{ ...routine("r-1", "Morning"), active: true }, routine("r-2", "Evening")]);
  await act(() => reading);

  expect(view.routines.map((item) => [item.id, item.active])).toEqual([
    ["r-1", false],
    ["r-2", undefined],
  ]);
  expect(view.routinesBotId).toBe("a");
});
