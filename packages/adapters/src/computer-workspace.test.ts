import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkpointComputerWorkspace,
  ensureComputerWorkspaceLayout,
  restoreComputerWorkspace,
} from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "workspace-test",
  traceId: "workspace-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const roots: string[] = [];
const snapshot = { homeKey: "bot-1", homeStorage: "snapshot", homeRevision: "empty" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider-neutral computer workspace", () => {
  it("prepares shared and bot folders for a Team Computer", async () => {
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision(
      { botId: "team-workspace", homePath: "/ignored" },
      context,
    );
    const execute = vi.spyOn(provider, "execute");

    await ensureComputerWorkspaceLayout(provider, computer, "team", "bot-1", context);

    expect(execute).toHaveBeenCalledWith(
      computer,
      { argv: ["mkdir", "-p", "shared", "bots/bot-1"] },
      context,
    );
  });

  it("restores a checkpoint into a replacement provider machine", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const firstProvider = new FakeSandboxProvider();
    const first = await firstProvider.provision({ botId: "bot-1", homePath: "/ignored" }, context);

    await firstProvider.writeFile(
      first,
      { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
      context,
    );
    const revision = await checkpointComputerWorkspace(
      home,
      firstProvider,
      snapshot,
      first,
      context,
    );

    const replacementProvider = new FakeSandboxProvider();
    const replacement = await replacementProvider.provision(
      { botId: "bot-1", homePath: "/different-provider" },
      context,
    );
    await restoreComputerWorkspace(home, replacementProvider, snapshot, replacement, context);

    expect(revision).toMatch(/^rev-/);
    expect(
      new TextDecoder().decode(
        await replacementProvider.readFile(replacement, "notes/result.txt", context),
      ),
    ).toBe("portable");
  });

  it("checkpoints a Docker computer on the local store by revision, without copying", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision({ botId: "bot-1", homePath: root }, context);
    const docker = { ...computer, kind: "docker" as const };
    const importWorkspace = vi.spyOn(provider, "importWorkspace");
    const exportWorkspace = vi.spyOn(provider, "exportWorkspace");
    const home = new LocalAgentHomeStore(root);

    await restoreComputerWorkspace(home, provider, snapshot, docker, context);
    const revision = await checkpointComputerWorkspace(home, provider, snapshot, docker, context);

    expect(revision).toMatch(/^rev-/);
    expect(importWorkspace).not.toHaveBeenCalled();
    expect(exportWorkspace).not.toHaveBeenCalled();
  });

  it("never imports or exports a home that lives on volumes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision({ botId: "bot-1", homePath: root }, context);
    const importWorkspace = vi.spyOn(provider, "importWorkspace");
    const exportWorkspace = vi.spyOn(provider, "exportWorkspace");
    const home = new LocalAgentHomeStore(root);
    const migrated = { homeKey: "bot-1", homeStorage: "volumes", homeRevision: "rev-stored" };

    await restoreComputerWorkspace(home, provider, migrated, computer, context);
    const revision = await checkpointComputerWorkspace(home, provider, migrated, computer, context);

    expect(revision).toBe("rev-stored");
    expect(importWorkspace).not.toHaveBeenCalled();
    expect(exportWorkspace).not.toHaveBeenCalled();
  });
});

describe("Team run checkpoints", () => {
  it("defers a remote export when another run prevents an exclusive checkpoint", async () => {
    const { checkpointRunComputerWorkspace } = await import("./computer-workspace.js");
    const exportWorkspace = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const deps = { sandbox: { exportWorkspace }, home: {}, prisma: { computer: { updateMany } } };
    const result = await checkpointRunComputerWorkspace(
      deps as never,
      {
        id: "team",
        homeKey: "team",
        scope: "team",
        homeStorage: "snapshot",
        homeRevision: "empty",
      },
      { id: "remote", providerRef: "remote", kind: "e2b", botId: "team" },
      { ...context, botId: "writer", screenLeaseId: "run-a:2" },
    );
    expect(result).toBeUndefined();
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "running",
          executionLeases: {
            none: { expiresAt: { gt: expect.any(Date) }, NOT: { runId: "run-a", fence: 2 } },
          },
        }),
        data: expect.objectContaining({ state: "suspending" }),
      }),
    );
  });

  it("restores the running state when an exclusive remote export fails", async () => {
    const { checkpointRunComputerWorkspace } = await import("./computer-workspace.js");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const exportWorkspace = vi.fn(async function* () {
      await Promise.reject(new Error("export failed"));
      yield { path: "unreachable", content: new Uint8Array() };
    });
    const deps = { sandbox: { exportWorkspace }, home: {}, prisma: { computer: { updateMany } } };
    await expect(
      checkpointRunComputerWorkspace(
        deps as never,
        {
          id: "team",
          homeKey: "team",
          scope: "team",
          homeStorage: "snapshot",
          homeRevision: "empty",
        },
        { id: "remote", providerRef: "remote", kind: "e2b", botId: "team" },
        { ...context, botId: "writer", screenLeaseId: "run-a:2" },
      ),
    ).rejects.toThrow("export failed");
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      exportWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "team", providerRef: "remote", state: "suspending" },
      data: { state: "running" },
    });
  });
});
