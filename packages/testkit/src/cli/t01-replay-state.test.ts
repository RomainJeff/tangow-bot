import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createT01ReplayIntent,
  createT01ReplayState,
  loadT01ReplayState,
  reapT01ReplayState,
  teardownT01ReplayState,
  updateT01ReplayIntent,
  withT01ReplayLock,
} from "./t01-replay-state.ts";

const records = { botId: "bot", computerId: "computer", spaceId: "space", userId: "user" };
const resources = {
  containerName: "container",
  networkName: "network",
  databaseContainerName: "database",
};
const secrets = {
  databaseUrl: "postgres://secret",
  supervisorToken: "secret",
  encryptionKey: "secret",
  testUserEmail: "test@example.test",
  testUserPassword: "secret",
};

describe("T01 private replay state", () => {
  it("reuses private state without putting secrets in the manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t01-replay-test-"));
    const state = await createT01ReplayState({
      directory,
      expiresAt: Date.now() + 60_000,
      resources,
      records,
      secrets,
    });
    const manifestText = await readFile(path.join(directory, "manifest.json"), "utf8");

    expect(manifestText).not.toContain("postgres://secret");
    expect(manifestText).not.toContain("supervisorToken");
    expect((await stat(directory)).mode & 0o077).toBe(0);
    expect((await stat(path.join(directory, "secrets.json"))).mode & 0o077).toBe(0);
    await expect(loadT01ReplayState(directory)).resolves.toMatchObject({
      manifest: state.manifest,
      secrets,
    });
  });

  it("refuses an expired state before a replay can use its secrets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t01-replay-test-"));
    await createT01ReplayState({ directory, expiresAt: 100, resources, records, secrets });
    await expect(loadT01ReplayState(directory, 100)).rejects.toThrow("has expired");
  });

  it("allows teardown to load an expired state without allowing replay", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t01-replay-test-"));
    await createT01ReplayState({ directory, expiresAt: 100, resources, records, secrets });
    await expect(loadT01ReplayState(directory, 100, { allowExpired: true })).resolves.toMatchObject(
      {
        manifest: { expiresAt: 100 },
      },
    );
  });

  it("writes owner intent before resource IDs and prevents a concurrent operation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t01-replay-test-"));
    const intent = await createT01ReplayIntent({
      directory,
      ownerId: "owner",
      expiresAt: Date.now() + 60_000,
      secrets,
    });
    expect(intent.manifest.resources).toEqual({});
    const held = withT01ReplayLock(directory, async () =>
      expect(withT01ReplayLock(directory, async () => undefined)).rejects.toThrow("already in use"),
    );
    await held;
    await expect(updateT01ReplayIntent(intent, { resources, records })).resolves.toMatchObject({
      manifest: { resources, records },
    });
  });

  it("recovers a lock left by a dead provision process so its owner can reap", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t01-replay-test-"));
    await writeFile(path.join(directory, ".lock"), JSON.stringify({ pid: 999_999_999 }), {
      mode: 0o600,
    });
    await expect(withT01ReplayLock(directory, async () => "recovered")).resolves.toBe("recovered");
  });

  it("reaps only the owner-labelled resources left after a crash before IDs are checkpointed", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t01-replay-test-"));
    const state = await createT01ReplayIntent({
      directory,
      ownerId: "crashed-owner",
      expiresAt: Date.now() - 1,
      secrets,
    });
    const labels = [
      "rakazo.t01.scope=isolated",
      "rakazo.t01.runner=live-subscription",
      "rakazo.t01.owner=crashed-owner",
    ];
    const removed: string[] = [];

    await reapT01ReplayState({
      state,
      listContainers: async () => ["uncheckpointed-db"],
      listNetworks: async () => ["uncheckpointed-network"],
      labelsForContainer: async () => labels,
      labelsForNetwork: async () => labels,
      removeContainer: async (name) => {
        removed.push(name);
      },
      removeNetwork: async (name) => {
        removed.push(name);
      },
      removeState: async () => {
        removed.push("state");
      },
    });
    expect(removed).toEqual(["uncheckpointed-db", "uncheckpointed-network", "state"]);
  });

  it("removes only resources with the exact state owner labels", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t01-replay-test-"));
    const state = await createT01ReplayState({
      directory,
      expiresAt: Date.now() + 60_000,
      resources,
      records,
      secrets,
    });
    const removed: string[] = [];
    const labels = [
      "rakazo.t01.scope=isolated",
      "rakazo.t01.runner=live-subscription",
      `rakazo.t01.owner=${state.manifest.ownerId}`,
    ];

    await teardownT01ReplayState({
      state,
      labelsForContainer: async () => labels,
      labelsForNetwork: async () => labels,
      removeContainer: async (name) => {
        removed.push(name);
      },
      removeNetwork: async (name) => {
        removed.push(name);
      },
      removeState: async () => {
        removed.push("state");
      },
    });
    expect(removed).toEqual(["container", "database", "network", "state"]);
  });

  it("refuses teardown when a recorded resource belongs to another state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "t01-replay-test-"));
    const state = await createT01ReplayState({
      directory,
      expiresAt: Date.now() + 60_000,
      resources,
      records,
      secrets,
    });

    await expect(
      teardownT01ReplayState({
        state,
        labelsForContainer: async () => ["rakazo.t01.scope=isolated"],
        labelsForNetwork: async () => ["rakazo.t01.scope=isolated"],
        removeContainer: async () => undefined,
        removeNetwork: async () => undefined,
      }),
    ).rejects.toThrow("not owned");
  });
});
