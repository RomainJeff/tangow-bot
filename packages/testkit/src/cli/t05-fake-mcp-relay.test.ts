import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const relay = fileURLToPath(new URL("./t05-fake-mcp-relay.mjs", import.meta.url));

describe("T05 fake MCP relay", () => {
  it("records the received method and expected bearer without persisting its value", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rakazo-t05-mcp-relay-"));
    const recordPath = path.join(directory, "requests.jsonl");
    const child = spawn(process.execPath, [relay], {
      env: {
        ...process.env,
        T05_MCP_RELAY_RECORD: recordPath,
        T05_MCP_RELAY_BEARER: "test-bearer",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const [line] = (await once(child.stdout, "data")) as [Buffer];
      const port = Number(line.toString("utf8").trim().split("=")[1]);
      const response = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-bearer",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
      });

      expect(response.ok).toBe(true);
      for (const method of ["GET", "DELETE"]) {
        const rejected = await fetch(`http://127.0.0.1:${port}/native-mcp`, { method });
        expect(rejected.status).toBe(405);
        expect(rejected.headers.get("allow")).toBe("POST");
      }
      await expect(readFile(recordPath, "utf8")).resolves.toBe(
        '{"method":"server/discover","bearer":"expected"}\n',
      );
    } finally {
      child.kill("SIGTERM");
      await once(child, "exit");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
