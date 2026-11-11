import type { Routine } from "@tangow/contracts";
import { describe, expect, it } from "vitest";
import { createRoutineRecords } from "./routine-records";

function routine(partial: Partial<Routine> = {}): Routine {
  return {
    id: "routine-1",
    botId: "bot-1",
    name: "Morning news",
    prompt: "Read the news.",
    crons: ["0 8 * * *"],
    timezone: "Europe/Paris",
    active: true,
    notify: false,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    requireToolApproval: true,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunFailureKind: null,
    nextRunAt: null,
    createdAt: "2026-10-01T09:00:00.000Z",
    ...partial,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("routine records", () => {
  it("keeps a schedule just added when the name saved before it answers last", async () => {
    const records = createRoutineRecords();
    await records.read("bot-1", async () => [routine()]);
    const nameSave = deferred<Routine>();
    const triggerSave = deferred<Routine>();
    const naming = records.write("bot-1", "routine-1", () => nameSave.promise, ["name"]);
    const scheduling = records.write("bot-1", "routine-1", () => triggerSave.promise, ["crons"]);
    triggerSave.resolve(routine({ crons: ["0 8 * * *", "0 18 * * *"] }));
    await scheduling;
    // The server answered the rename from the row it held before the schedule was added.
    nameSave.resolve(routine({ name: "Evening news" }));
    await naming;
    expect(records.routines("bot-1")).toEqual([
      routine({ name: "Evening news", crons: ["0 8 * * *", "0 18 * * *"] }),
    ]);
  });

  it("keeps what writes answered during a list read, and a removed routine stays gone", async () => {
    const records = createRoutineRecords();
    await records.read("bot-1", async () => [routine(), routine({ id: "routine-2", name: "Old" })]);
    const list = deferred<Routine[]>();
    const reading = records.read("bot-1", () => list.promise);
    await records.write("bot-1", "routine-1", async () => routine({ active: false }), ["active"]);
    await records.remove("bot-1", "routine-2", async () => undefined);
    await records.create("bot-1", async () => routine({ id: "routine-3", name: "New" }));
    list.resolve([
      routine({ prompt: "Changed by the bot" }),
      routine({ id: "routine-2", name: "Old" }),
    ]);
    await reading;
    expect(records.routines("bot-1")?.map((item) => [item.id, item.active, item.prompt])).toEqual([
      ["routine-1", false, "Read the news."],
      ["routine-3", true, "Read the news."],
    ]);

    await records.read("bot-1", async () => [routine({ prompt: "Changed by the bot" })]);
    expect(records.routines("bot-1")?.map((item) => [item.id, item.prompt])).toEqual([
      ["routine-1", "Changed by the bot"],
    ]);
  });

  it("forgets everything on reset and ignores answers still in flight", async () => {
    const records = createRoutineRecords();
    await records.read("bot-1", async () => [routine()]);
    const late = deferred<Routine>();
    const writing = records.write("bot-1", "routine-1", () => late.promise, ["name"]);
    records.reset();
    late.resolve(routine({ name: "Late" }));
    await writing;
    expect(records.routines("bot-1")).toBeUndefined();
  });
});
