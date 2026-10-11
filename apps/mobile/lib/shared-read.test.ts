import { describe, expect, it } from "vitest";
import { createSharedRead } from "./shared-read";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("a shared read", () => {
  it("gives a second screen the value the first one read, without reading again", async () => {
    let clock = 0;
    const read = createSharedRead<string[]>(() => clock);
    let loads = 0;
    const load = async () => {
      loads += 1;
      return ["alloy", "verse"];
    };
    await Promise.all([read.refresh(load), read.refresh(load)]);
    clock = 5_000;
    await read.refresh(load);

    expect(read.state()).toEqual({ kind: "ready", value: ["alloy", "verse"] });
    expect(loads).toBe(1);
  });

  it("says a first read failed, keeps a shown value when a later one fails, and reads on Retry", async () => {
    let clock = 0;
    const read = createSharedRead<string>(() => clock);
    await read.refresh(() => Promise.reject(new Error("offline")));
    expect(read.state()).toEqual({ kind: "failed" });

    await read.refresh(async () => "first");
    clock = 60_000;
    await read.refresh(() => Promise.reject(new Error("offline")));
    expect(read.state()).toEqual({ kind: "ready", value: "first" });

    await read.refresh(async () => "second", { force: true });
    expect(read.state()).toEqual({ kind: "ready", value: "second" });
  });

  it("ignores an answer to a read started before sign-out", async () => {
    const read = createSharedRead<string>();
    const late = deferred<string>();
    const pending = read.refresh(() => late.promise);
    read.reset();
    late.resolve("last person's models");
    await pending;

    expect(read.state()).toEqual({ kind: "loading" });
  });
});
