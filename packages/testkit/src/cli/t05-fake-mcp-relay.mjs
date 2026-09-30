import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

const recordPath = process.env.T05_MCP_RELAY_RECORD;
const expectedBearer = process.env.T05_MCP_RELAY_BEARER;
const port = Number(process.env.T05_MCP_RELAY_PORT ?? "0");

if (!recordPath || !expectedBearer || !Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("T05 fake MCP relay requires a record path, expected bearer, and valid port");
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" || request.method === "DELETE") {
    response.writeHead(405, { allow: "POST", "content-type": "application/json" });
    response.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    body = {};
  }
  const authorization = request.headers.authorization;
  await appendFile(
    recordPath,
    `${JSON.stringify({
      method: typeof body.method === "string" ? body.method : null,
      bearer: authorization === `Bearer ${expectedBearer}` ? "expected" : "unexpected",
    })}\n`,
  );
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        serverInfo: { name: "t05-fake-mcp-relay", version: "1" },
      },
    }),
  );
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("T05 fake MCP relay has no TCP port");
  console.log(`T05_MCP_RELAY_PORT=${address.port}`);
});

process.once("SIGTERM", () => server.close());
process.once("SIGINT", () => server.close());
