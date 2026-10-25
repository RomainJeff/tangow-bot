/**
 * A guest that speaks the run channel by hand, so it can ask for what a conforming guest never
 * would. The live refusal lane writes its bundle into a worker VM in place of the real guest:
 *
 *   node hostile-guest.mjs model_target   a model call naming its own model, endpoint and key
 *   node hostile-guest.mjs unknown_tool   a call to a tool the run does not expose
 *
 * It reports every controller message it received on stderr and exits once the controller closes
 * the channel.
 */
import type { GuestBody } from "@rakazo/adapter-kit";
import { WORKER_PROTOCOL_VERSION, workerHarness } from "@rakazo/adapter-kit";
import {
  capabilityWorker,
  encodeMessage,
  readControllerFrame,
  streamChannel,
  WORKER_LIMITS,
} from "@rakazo/adapters/runtime-worker/wire";

const REQUESTS: Record<string, GuestBody> = {
  model_target: {
    type: "model.request",
    agent: "root",
    dialect: "pi-ai",
    call: {
      context: { messages: [{ role: "user", content: "Hi", timestamp: 0 }] },
      options: {
        model: "another-model",
        baseUrl: "https://foreign.invalid/v1",
        apiKey: "guest-key",
      },
    },
  } as unknown as GuestBody,
  unknown_tool: { type: "tool", name: "drop_tables", args: {}, executionId: "x1" },
};

const capability = process.env.RAKAZO_WORKER_CAPABILITY ?? "";
const worker = capabilityWorker(capability);
const request = REQUESTS[process.argv[2] ?? ""];
if (!worker || !request) {
  process.stderr.write("hostile guest: no capability or unknown request\n");
  process.exit(2);
}

const channel = streamChannel(process.stdin, process.stdout, WORKER_LIMITS.controllerFrameBytes);
await channel.send(
  encodeMessage({
    version: WORKER_PROTOCOL_VERSION,
    kind: "worker.hello",
    worker,
    capability,
    harness: workerHarness(process.env.RAKAZO_WORKER_HARNESS ?? "pi-native"),
  }),
);
const received: string[] = [];
for await (const frame of channel.frames) {
  const read = readControllerFrame(frame);
  if (!read.ok) continue;
  const message = read.message;
  received.push(
    message.kind === "worker.reply"
      ? `reply:${JSON.stringify(message.payload.body)}`
      : message.kind,
  );
  if (message.kind === "worker.start") {
    await channel.send(
      encodeMessage({
        version: WORKER_PROTOCOL_VERSION,
        kind: "worker.event",
        worker,
        payload: { seq: 1, body: request },
      }),
    );
  }
}
process.stderr.write(`hostile guest received: ${JSON.stringify(received)}\n`);
