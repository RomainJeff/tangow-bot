import type { ComputerRef, SandboxProvider } from "@tangow/adapter-kit";
import { describe, expect, it } from "vitest";
import { E2BSandboxEmulator } from "./e2b-emulator.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { provisionPrepared } from "./sandbox-test-support.js";

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

async function drain(provider: SandboxProvider, computer: ComputerRef) {
  let stdout = "";
  for await (const event of provider.execute(computer, { argv: ["echo", "graphical-ok"] }, ctx)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") expect(event.code).toBe(0);
  }
  return stdout;
}

describe("sandbox conformance", () => {
  it("runs the same graphical command across fake and the E2B emulator", async () => {
    const fake = new FakeSandboxProvider();
    const managed = new E2BSandboxEmulator();
    const a = await provisionPrepared(fake, { botId: "bot-a", homePath: "/tmp/a" }, ctx);
    const b = await provisionPrepared(managed, { botId: "bot-b", homePath: "/tmp/b" }, ctx);
    expect(await drain(fake, a)).toContain("graphical-ok");
    expect(await drain(managed, b)).toContain("graphical-ok");
    expect(a.id).not.toBe(b.id);
    await fake.destroy(a, ctx);
    await managed.destroy(b, ctx);
  });

  it("offers the same observation, action, and workspace contract across providers", async () => {
    const providers: SandboxProvider[] = [new FakeSandboxProvider(), new E2BSandboxEmulator()];
    for (const [index, provider] of providers.entries()) {
      const computer = await provisionPrepared(
        provider,
        { botId: `portable-${index}`, homePath: `/tmp/portable-${index}` },
        ctx,
      );
      await provider.prepare(computer, ctx);
      await provider.writeFile(
        computer,
        { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
        ctx,
      );
      expect(await provider.listFiles(computer, "notes", ctx)).toEqual([
        { path: "notes/result.txt", kind: "file", size: 8 },
      ]);
      expect(
        new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", ctx)),
      ).toBe("portable");
      const binary = Uint8Array.from([0, 255, 1, 128]);
      await provider.writeFile(
        computer,
        { path: "bin/tool", content: binary, executable: true },
        ctx,
      );
      expect(await provider.readFile(computer, "bin/tool", ctx)).toEqual(binary);
      expect(await provider.listFiles(computer, "bin", ctx)).toEqual([
        { path: "bin/tool", kind: "file", size: 4, executable: true },
      ]);
      const acted = await provider.act(
        computer,
        { actions: [{ kind: "clipboard", text: "visible" }], observe: true },
        ctx,
      );
      expect(acted.completed).toBe(1);
      expect(acted.observation?.image.byteLength).toBeGreaterThan(0);
      const exported = [];
      for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
      expect(exported.map((file) => file.path)).toContain("notes/result.txt");
      expect(exported.find((file) => file.path === "bin/tool")).toMatchObject({
        content: binary,
        executable: true,
      });
      await provider.destroy(computer, ctx);
    }
  });

  it("treats a repeated destroy as success so a stale deletion retry is safe", async () => {
    const providers: SandboxProvider[] = [new FakeSandboxProvider(), new E2BSandboxEmulator()];
    for (const [index, provider] of providers.entries()) {
      const computer = await provisionPrepared(
        provider,
        { botId: `destroy-twice-${index}`, homePath: `/tmp/destroy-twice-${index}` },
        ctx,
      );
      await provider.destroy(computer, ctx);
      await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    }
  });
});
