import { createServer } from "node:http";
import { Sandbox } from "e2b";
import { expect, it, vi } from "vitest";
import { liveSession } from "./session.js";

it("preserves the sandbox deadline in the real SDK upload connect request", async () => {
  const bodies: unknown[] = [];
  const endAt = new Date(Date.now() + 18_000).toISOString();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === "POST") bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        sandboxID: "fake-upload",
        templateID: "fake-template",
        envdVersion: "0.4.5",
        domain: "example.invalid",
        endAt,
        startedAt: new Date().toISOString(),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const connect = Sandbox.connect.bind(Sandbox);
  const spy = vi.spyOn(Sandbox, "connect").mockImplementation(async (id, options) => {
    const vm = await connect(id, options);
    // Stop at the next network boundary: the connect itself uses the real installed SDK.
    vi.spyOn(vm.files, "write").mockRejectedValue(new Error("Upload boundary reached"));
    return vm;
  });
  try {
    const live = liveSession({
      apiKey: "fake-key",
      apiUrl: `http://127.0.0.1:${address.port}`,
      workerTemplate: "fake-worker",
      computerTemplate: "fake-computer",
    });
    const provider = live.workerProvider(undefined, { path: "/tmp/fake-guest.mjs", script: "" });
    const channel = provider.connect(
      { attemptId: "fake-attempt", providerRef: "fake-upload" },
      "fake-capability",
    );
    for await (const _connection of channel.connections)
      throw new Error("Upload must stop before guest execution");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({ timeout: expect.any(Number) });
    const body = bodies[0];
    if (
      typeof body !== "object" ||
      body === null ||
      !("timeout" in body) ||
      typeof body.timeout !== "number"
    )
      throw new Error("Missing serialized timeout");
    expect(body.timeout).toBeGreaterThan(0);
    expect(body.timeout).toBeLessThanOrEqual(18);
    expect(live.guestUploadDeadlines).toEqual([
      { before: endAt, after: endAt, timeoutMs: expect.any(Number) },
    ]);
  } finally {
    spy.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
