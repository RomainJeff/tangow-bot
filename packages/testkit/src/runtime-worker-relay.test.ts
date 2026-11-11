import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { relayPiAiCall } from "@tangow/adapters/runtime-worker/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { toolResult } from "./file-task.js";
import type { ModelEmulatorRequest } from "./model-emulator.js";
import { afterPrivateText, startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("a worker run whose native reads return images", () => {
  it("keeps every image in its history so the relay evicts the oldest a block at a time", async () => {
    const sent: string[][] = [];
    const record = (request: ModelEmulatorRequest) => {
      sent.push(
        [...JSON.stringify(request.messages).matchAll(/data:image\/png;base64,([^"]+)/g)].map(
          (match) => /file-\d/.exec(Buffer.from(match[1] ?? "", "base64").toString())?.[0] ?? "",
        ),
      );
    };
    const run = await startWorkerRun({
      maxImagesPerPrompt: 2,
      steps: [
        ...[1, 2, 3].map((file) => ({
          expect: record,
          response: {
            type: "tool" as const,
            id: `read-${file}`,
            name: "read",
            arguments: { path: `file-${file}.png` },
          },
        })),
        {
          expect: record,
          response: {
            type: "text" as const,
            text: JSON.stringify({ version: 1, results: ["Read"], references: [] }),
          },
        },
        afterPrivateText,
      ],
    });
    cleanups.push(() => run.close());
    const home = run.provider.volumePath("bot_private");
    await mkdir(home, { recursive: true });
    // A 1x1 PNG; the bytes after its end name the file.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    );
    for (const file of [1, 2, 3]) {
      await writeFile(
        path.join(home, `file-${file}.png`),
        Buffer.concat([png, Buffer.from(`file-${file}`)]),
      );
    }

    const runId = await run.send("Look at the three files.");
    await run.continueRun(runId);

    run.model.assertComplete();
    expect(sent).toEqual([[], ["file-1"], ["file-1", "file-2"], ["file-3"]]);
  });
});

describe("a worker run on a catalog Anthropic model", () => {
  it("completes a run on Anthropic's Messages API through the relay, across a thinking block and a tool call", async () => {
    let listed = "";
    const run = await startWorkerRun({
      protocol: "anthropic",
      steps: [
        {
          expect(request) {
            expect(request.messages.at(-1)).toMatchObject({ role: "user" });
          },
          response: {
            type: "tool",
            id: "toolu_1",
            name: "bash",
            arguments: { command: "echo listed" },
          },
        },
        {
          expect(request) {
            listed = toolResult(request);
          },
          response: {
            type: "tool",
            id: "toolu_2",
            name: "message_user",
            arguments: { message: "Done." },
          },
        },
        {
          expect() {},
          response: {
            type: "text",
            thinking: "The command printed its word.",
            text: JSON.stringify({ version: 1, results: ["Listed"], references: [] }),
            usage: { promptTokens: 210, completionTokens: 12, cacheReadTokens: 64 },
          },
        },
      ],
    });
    cleanups.push(() => run.close());

    const runId = await run.send("List it.");
    await run.continueRun(runId);

    const row = await run.prisma.run.findUniqueOrThrow({ where: { id: runId } });
    expect(row).toMatchObject({ status: "completed", modelProvider: "anthropic" });
    run.model.assertComplete();
    expect(listed).toContain("listed");
    const usage = await run.prisma.usageRecord.findMany({ where: { runId } });
    expect(usage.at(-1)).toMatchObject({ provider: "anthropic", outputTokens: 12 });
    // Anthropic reports cache reads apart from input tokens; the run counts both.
    const finished = (await run.runEntries(runId)).find((entry) => entry.type === "run.finished");
    expect(finished?.payload).toMatchObject({ usage: { inputTokens: 210 + 64, outputTokens: 12 } });
  });
});

describe("partial relay usage", () => {
  it.each(["disconnect", "abort", "closed channel"] as const)(
    "counts provider usage after %s",
    async (failure) => {
      const controller = new AbortController();
      const server = createServer((request, response) => {
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        const emit = (event: Record<string, unknown>) =>
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        emit({
          type: "message_start",
          message: {
            id: "partial",
            type: "message",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [],
            stop_reason: null,
            usage: {
              input_tokens: 120,
              output_tokens: 0,
              cache_read_input_tokens: 40,
              cache_creation_input_tokens: 0,
            },
          },
        });
        emit({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        emit({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Partial." },
        });
        if (failure === "disconnect") response.write(": close\n\n", () => response.destroy());
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      cleanups.push(async () => {
        controller.abort();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing emulator port");
      const catalogModel = ANTHROPIC_MODELS["claude-haiku-4-5"];
      const originalBaseUrl = catalogModel.baseUrl;
      catalogModel.baseUrl = `http://127.0.0.1:${address.port}`;
      cleanups.push(async () => {
        catalogModel.baseUrl = originalBaseUrl;
      });
      const events: string[] = [];
      let channelClosed = false;
      const usage = await relayPiAiCall(
        { provider: "anthropic", id: catalogModel.id, apiKey: "local" },
        { context: { messages: [{ role: "user", content: "Continue." }] }, options: {} },
        (event) => {
          if (channelClosed) throw new Error("Closed guest channel");
          events.push(event.type);
          if (event.type !== "text_delta" || failure === "disconnect") return;
          controller.abort();
          if (failure === "closed channel") {
            channelClosed = true;
            throw new Error("Closed guest channel");
          }
        },
        { signal: controller.signal, conversation: { threadId: "partial", botId: "bot" } },
      );
      expect(events).toContain("text_delta");
      expect(usage).toEqual({
        type: "usage",
        inputTokens: 160,
        outputTokens: 0,
        cacheReadTokens: 40,
        cacheWriteTokens: 0,
        provider: "anthropic",
        model: catalogModel.id,
      });
    },
  );
});
