import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { resolveSupervisorToken } from "@tangow/core";
import { createLogger, createTestSink, installLogger } from "@tangow/logging";
import { expect, it } from "vitest";

// Build the worker image first (rakazo/worker:local, or RAKAZO_WORKER_IMAGE). Needs Docker only.
it.skipIf(process.env.VERIFY_DOCKER_WORKERS !== "1")(
  "creates a hardened worker on its volume, relays the guest, and removes it",
  async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-workers-"));
    const volume = path.join(dataDir, "volumes", "rakazo-private");
    mkdirSync(volume, { recursive: true });
    process.env.DATA_DIR = dataDir;
    // DATA_DIR is read when the supervisor module loads.
    const { supervisorApp, upgradeWorkerGuest } = await import("./index.js");
    const headers = {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
    };
    const attemptId = `attempt-${randomUUID()}`;
    const docker = (...args: string[]) =>
      execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();
    const server = http.createServer();
    server.on("upgrade", (request, socket, head) => void upgradeWorkerGuest(request, socket, head));
    try {
      const create = () =>
        supervisorApp.request("/workers", {
          method: "POST",
          headers,
          body: JSON.stringify({
            attemptId,
            ttlSeconds: 120,
            mounts: [{ volume: "rakazo-private", path: "/workspace/bot", readOnly: false }],
          }),
        });
      const created = await create();
      const body = (await created.json()) as { id: string; error?: string };
      expect(body.error).toBeUndefined();
      const { id } = body;
      expect(await (await create()).json()).toEqual({ id });

      const info = JSON.parse(docker("inspect", id))[0];
      expect(Object.keys(info.NetworkSettings.Networks)).toEqual(["rakazo-workers"]);
      expect(
        docker(
          "network",
          "inspect",
          "rakazo-workers",
          "--format",
          '{{index .Options "com.docker.network.bridge.enable_icc"}}',
        ),
      ).toBe("false");
      docker("exec", id, "sh", "-c", "echo written > /workspace/bot/file");
      expect(readFileSync(path.join(volume, "file"), "utf8")).toBe("written\n");

      const sink = createTestSink();
      installLogger(createLogger({ service: "test", sinks: [sink] }));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      const socket = await new Promise<Duplex>((resolve, reject) => {
        http
          .request({
            host: "127.0.0.1",
            port,
            path: `/workers/${id}/guest`,
            headers: {
              ...headers,
              connection: "Upgrade",
              upgrade: "rakazo-guest",
              "x-rakazo-worker-capability": "not-the-attempt-capability",
            },
          })
          .on("upgrade", (_response, upgraded) => resolve(upgraded))
          .on("response", (response) => reject(new Error(`status ${response.statusCode}`)))
          .on("error", reject)
          .end();
      });
      // The guest refuses a capability it cannot read, and its exit is logged.
      socket.resume();
      await new Promise((resolve) => socket.on("close", resolve));
      await expect.poll(() => sink.events.length, { timeout: 5_000 }).toBe(1);
      expect(sink.events[0]).toMatchObject({
        message: "docker worker guest exited with an error",
        attemptId,
        exitCode: 1,
      });
      expect(String(sink.events[0]?.stderrTail)).toContain("Unreadable worker capability");

      const removed = await supervisorApp.request(`/workers?attempt=${attemptId}`, {
        method: "DELETE",
        headers,
      });
      expect(await removed.json()).toEqual({ destroyed: true });
      expect(docker("ps", "-aq", "--filter", `label=rakazo.attempt=${attemptId}`)).toBe("");
      expect(existsSync(path.join(volume, "file"))).toBe(true);
    } finally {
      server.close();
      execFileSync("sh", [
        "-c",
        `docker rm -f $(docker ps -aq --filter label=rakazo.attempt=${attemptId}) 2>/dev/null || true`,
      ]);
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
  120_000,
);
