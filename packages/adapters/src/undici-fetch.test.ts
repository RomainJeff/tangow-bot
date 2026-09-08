import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { describe, expect, it } from "vitest";
import { dispatchableFetch } from "./undici-fetch.js";

describe("dispatchableFetch", () => {
  it("drives an undici Agent, which Node's bundled fetch cannot always do", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const dispatcher = new Agent();
    try {
      const response = await dispatchableFetch(`http://127.0.0.1:${port}/`, {
        dispatcher,
      } as RequestInit & { dispatcher: Agent });
      await expect(response.text()).resolves.toBe("ok");
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
