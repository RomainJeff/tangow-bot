import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { WireProtocol, WireStep } from "./pi-sdk-proof-support.js";
import {
  chainDurableSteering,
  createProofSession,
  proofModelRuntime,
} from "./pi-sdk-proof-support.js";
import {
  calls,
  deferred,
  done,
  fixture,
  KEY,
  lines,
  PROTOCOLS,
  persisted,
  session,
  settledWithin,
  steeringStore,
  text,
  tool,
  track,
  usePoisonedWorkspace,
  workspace,
} from "./pi-sdk-test-support.js";

usePoisonedWorkspace();

describe.each(PROTOCOLS)("Pi SDK session over %s", (protocol) => {
  it("stops later effects and inference when a sequential approval aborts its batch", async () => {
    const effects: string[] = [];
    const wire = await fixture(protocol, [calls("safe", "approval", "later")]);
    const store = steeringStore();
    const approval = tool(
      "approval",
      async (_id, _params, _signal, _update, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        effects.push("approval");
        ctx.abort();
        return { ...done("approval pending"), terminate: true };
      },
      { executionMode: "sequential" },
    );
    const created = await session(wire, {
      systemPrompt: "Fixture system.",
      tools: [
        tool("safe", async () => {
          effects.push("safe");
          return done("safe done");
        }),
        approval,
        tool("later", async () => {
          effects.push("later");
          return done("later done");
        }),
      ],
    });
    chainDurableSteering(created, (seenIds) => store.claim(seenIds));
    store.add("arrives after approval");
    await settledWithin(5_000, created.prompt("go", { expandPromptTemplates: false }));

    wire.assertComplete();
    expect(effects).toEqual(["safe", "approval"]);
    expect(store.claims).toEqual([]);
    expect(persisted(created)).toEqual([
      "user: go",
      "call call-safe safe {}",
      "call call-approval approval {}",
      "call call-later later {}",
      "tool call-safe: safe done",
      "tool call-approval: approval pending",
    ]);
  });

  it("aborts a held inference, closes its stream and settles", async () => {
    const closed = deferred();
    const wire = await fixture(protocol, [
      () => ({
        type: "hold",
        blocks: [{ type: "text", text: "partial" }],
        onClose: closed.resolve,
      }),
    ]);
    const created = await session(wire);
    const streaming = deferred();
    created.agent.subscribe((event) => {
      if (event.type === "message_update") streaming.resolve();
    });
    const run = created.prompt("go", { expandPromptTemplates: false });
    await streaming.promise;
    expect(wire.openResponses()).toBe(1);
    await settledWithin(5_000, Promise.all([created.abort().then(() => run), closed.promise]));

    expect(wire.openResponses()).toBe(0);
    expect(created.isIdle).toBe(true);
    expect(created.agent.signal).toBeUndefined();
    wire.assertComplete();
  });
});

describe("Pi SDK session lifecycle", () => {
  const protocol: WireProtocol = "openai-completions";

  it("runs a later sibling and another turn when an approval only sets terminate", async () => {
    const effects: string[] = [];
    const wire = await fixture(protocol, [calls("approval", "later"), text("continued")]);
    const created = await session(wire, {
      systemPrompt: "Fixture system.",
      tools: [
        tool(
          "approval",
          async () => {
            effects.push("approval");
            return { ...done("approval pending"), terminate: true };
          },
          { executionMode: "sequential" },
        ),
        tool("later", async () => {
          effects.push("later");
          return done("later done");
        }),
      ],
    });
    await created.prompt("go", { expandPromptTemplates: false });

    wire.assertComplete();
    expect(effects).toEqual(["approval", "later"]);
    expect(wire.requests).toHaveLength(2);
  });

  it("lets a later parallel sibling start before an asynchronous approval aborts", async () => {
    const effects: string[] = [];
    const wire = await fixture(protocol, [calls("approval", "later")]);
    const created = await session(wire, {
      systemPrompt: "Fixture system.",
      tools: [
        tool("approval", async (_id, _params, _signal, _update, ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          effects.push("approval");
          ctx.abort();
          return { ...done("approval pending"), terminate: true };
        }),
        tool("later", async () => {
          effects.push("later");
          return done("later done");
        }),
      ],
    });
    await created.prompt("go", { expandPromptTemplates: false });

    wire.assertComplete();
    expect(effects).toEqual(["later", "approval"]);
  });

  it("persists a durable claim that abort races before the next request", async () => {
    const store = steeringStore();
    const wire = await fixture(protocol, [calls("noop")]);
    const created = await session(wire, {
      systemPrompt: "Fixture system.",
      tools: [tool("noop", async () => done("noop done"))],
    });
    const ended: string[] = [];
    created.agent.subscribe(async (event) => {
      if (event.type === "message_end") ended.push(...lines(event.message));
    });
    chainDurableSteering(created, async (seenIds) => {
      const claimed = await store.claim(seenIds);
      created.agent.abort();
      return claimed;
    });
    store.add("claimed during abort");
    await settledWithin(5_000, created.prompt("go", { expandPromptTemplates: false }));

    wire.assertComplete();
    expect(store.unclaimed()).toEqual([]);
    expect(ended).toContain("user: claimed during abort");
    expect(persisted(created)).toEqual([
      "user: go",
      "call call-noop noop {}",
      "tool call-noop: noop done",
      "user: claimed during abort",
    ]);
  });

  it("leaves steering that arrives during a final text turn for the next run", async () => {
    const store = steeringStore();
    const wire = await fixture(protocol, [
      (request) => {
        store.add("late");
        return text("final")(request);
      },
    ]);
    const created = await session(wire);
    chainDurableSteering(created, (seenIds) => store.claim(seenIds));
    await created.prompt("go", { expandPromptTemplates: false });

    wire.assertComplete();
    expect(store.claims).toEqual([]);
    expect(store.unclaimed()).toEqual(["late"]);
  });

  it("aborts a held tool and a helper through the parent signal", async () => {
    const helperClosed = deferred();
    const helperStreaming = deferred();
    const toolStarted = deferred();
    const wire = await fixture(protocol, [calls("held", "helper")]);
    const helperWire = await fixture(protocol, [
      () => ({
        type: "hold",
        blocks: [{ type: "text", text: "partial" }],
        onClose: helperClosed.resolve,
      }),
    ]);
    const helperRuntime = await proofModelRuntime(helperWire, KEY);
    let child: AgentSession | undefined;
    const created = await session(wire, {
      systemPrompt: "Fixture system.",
      tools: [
        tool("held", async (_id, _params, signal) => {
          toolStarted.resolve();
          await new Promise((resolve) => signal?.addEventListener("abort", resolve));
          return done("held stopped");
        }),
        tool("helper", async (_id, _params, signal) => {
          child = await createProofSession({
            cwd: workspace.cwd,
            agentDir: workspace.agentDir,
            runtime: helperRuntime,
            systemPrompt: "Helper system.",
          });
          child.agent.subscribe((event) => {
            if (event.type === "message_update") helperStreaming.resolve();
          });
          const stop = () => void child?.abort();
          signal?.addEventListener("abort", stop);
          try {
            await child.prompt("helper task", { expandPromptTemplates: false });
            return done(child.getLastAssistantText() ?? "");
          } finally {
            signal?.removeEventListener("abort", stop);
            child.dispose();
          }
        }),
      ],
    });
    const run = created.prompt("go", { expandPromptTemplates: false });
    await Promise.all([toolStarted.promise, helperStreaming.promise]);
    expect(helperWire.openResponses()).toBe(1);
    await settledWithin(
      5_000,
      Promise.all([created.abort().then(() => run), helperClosed.promise]),
    );

    expect(helperWire.openResponses()).toBe(0);
    expect(created.isIdle).toBe(true);
    expect(child?.isIdle).toBe(true);
    wire.assertComplete();
    helperWire.assertComplete();
  });

  it("settles prompt only after every async agent listener settles", async () => {
    const wire = await fixture(protocol, [text("done")]);
    const created = await session(wire);
    const gatedListener = () => {
      const entered = deferred();
      const release = deferred();
      created.agent.subscribe(async (event) => {
        if (event.type !== "agent_end") return;
        entered.resolve();
        await release.promise;
      });
      return { entered, release };
    };
    const [first, second] = [gatedListener(), gatedListener()];
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    let settled = false;
    const run = created.prompt("go", { expandPromptTemplates: false }).then(() => {
      settled = true;
    });

    await first.entered.promise;
    await flush();
    expect(settled).toBe(false);
    first.release.resolve();
    await second.entered.promise;
    await flush();
    expect(settled).toBe(false);
    second.release.resolve();
    await settledWithin(5_000, run);
    expect(settled).toBe(true);
  });

  it("keeps two interleaved sessions on one runtime to their own history", async () => {
    const names = ["one", "two"] as const;
    const arrived = [deferred(), deferred(), deferred(), deferred()];
    const reply =
      (index: number): WireStep =>
      async (request) => {
        arrived[index]?.resolve();
        await arrived[index ^ 1]?.promise;
        const name = request.transcript.includes("user: one prompt") ? "one" : "two";
        if (request.transcript.at(-1) !== `user: ${name} prompt`)
          return text(`${name} done`)(request);
        return {
          type: "message",
          blocks: [{ type: "tool", id: `call-${name}`, name: "lookup", arguments: {} }],
        };
      };
    const wire = await fixture(
      protocol,
      arrived.map((_, index) => reply(index)),
    );
    const runtime = await proofModelRuntime(wire, KEY);
    const both = await Promise.all(
      names.map(async (name) => {
        const created = await createProofSession({
          cwd: workspace.cwd,
          agentDir: workspace.agentDir,
          runtime,
          systemPrompt: "Fixture system.",
          transcript: {
            kind: "history",
            messages: [{ role: "user", content: `${name} history`, timestamp: 0 }],
          },
          tools: [tool("lookup", async () => done(`${name} looked`))],
        });
        track(created);
        return { name, created };
      }),
    );
    await settledWithin(
      5_000,
      Promise.all(
        both.map(({ name, created }) =>
          created.prompt(`${name} prompt`, { expandPromptTemplates: false }),
        ),
      ),
    );

    wire.assertComplete();
    expect(wire.requests.map((request) => request.credential)).toEqual([KEY, KEY, KEY, KEY]);
    for (const { name, created } of both) {
      const own = [
        `user: ${name} history`,
        `user: ${name} prompt`,
        `call call-${name} lookup {}`,
        `tool call-${name}: ${name} looked`,
      ];
      expect(
        wire.requests
          .map((request) => request.transcript.slice(1))
          .filter((transcript) => transcript.some((line) => line.includes(name))),
      ).toEqual([own.slice(0, 2), own]);
      expect(persisted(created)).toEqual([...own, `assistant: ${name} done`]);
    }
  });
});
