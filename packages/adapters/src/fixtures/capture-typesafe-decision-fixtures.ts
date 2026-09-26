/**
 * Manual, outside CI: replays the conformance requests against a real System One
 * endpoint and rewrites typesafe-decision.json. The API key is read from stdin so
 * it never lands in shell history or the environment.
 *
 *   pnpm exec tsx packages/adapters/src/fixtures/capture-typesafe-decision-fixtures.ts [baseUrl] < key.txt
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseTypeSafeDecisionConnection, TypeSafeDecisionProvider } from "../typesafe-decision.js";
import { decisionConformanceRequests } from "./decision-requests.js";

const fixturePath = new URL("./typesafe-decision.json", import.meta.url);
const apiKey = readFileSync(0, "utf8").trim();
const connection = parseTypeSafeDecisionConnection(
  process.argv[2] ? { baseUrl: process.argv[2] } : {},
  { apiKey },
);
const responses: Record<string, unknown> = {};
let current = "";
const provider = new TypeSafeDecisionProvider(connection, {
  fetch: async (input, init) => {
    const response = await fetch(input, init);
    responses[current] = await response.clone().json();
    return response;
  },
});
for (const [name, request] of Object.entries(decisionConformanceRequests)) {
  current = name;
  await provider.decide(request, {
    operationId: "capture",
    traceId: "capture",
    spaceId: "capture",
    userId: "capture",
    signal: AbortSignal.timeout(10_000),
  });
}
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { note: string };
writeFileSync(fixturePath, `${JSON.stringify({ note: fixture.note, responses }, null, 2)}\n`);
