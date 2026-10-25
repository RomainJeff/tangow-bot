import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSteeringMessage } from "@rakazo/adapter-kit";
import { afterEach, beforeEach } from "vitest";
import type { WireFixture, WireProtocol, WireStep } from "./pi-sdk-proof-support.js";
import { createProofSession, proofModelRuntime, startWireFixture } from "./pi-sdk-proof-support.js";

export const KEY = "fixture-key";
const POISON = "POISON";
export const PROTOCOLS: WireProtocol[] = ["openai-completions", "anthropic-messages"];

export const workspace = { root: "", home: "", cwd: "", agentDir: "" };
let previousHome: string | undefined;
const fixtures: WireFixture[] = [];
const sessions: AgentSession[] = [];

async function seedPoison(base: string) {
  const files: Record<string, string> = {
    "AGENTS.md": `${POISON} agents`,
    "CLAUDE.md": `${POISON} claude`,
    ".pi/SYSTEM.md": `${POISON} system`,
    ".pi/APPEND_SYSTEM.md": `${POISON} append`,
    ".pi/settings.json": JSON.stringify({ compaction: { enabled: true, reserveTokens: 1 } }),
    ".pi/skills/poison/SKILL.md": `---\nname: poison\ndescription: ${POISON} skill\n---\n${POISON}`,
    ".pi/prompts/poison.md": `${POISON} template`,
    ".pi/extensions/poison.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(base, "extension-loaded"))}, "${POISON}");\nexport default () => {};\n`,
    ".pi/agent/auth.json": JSON.stringify(
      Object.fromEntries(
        PROTOCOLS.map((protocol) => [
          `rakazo-proof-${protocol}`,
          { type: "api_key", key: `${POISON}-key` },
        ]),
      ),
    ),
    ".pi/agent/settings.json": JSON.stringify({
      defaultProvider: "openai",
      retry: { enabled: true },
    }),
    ".pi/agent/models.json": JSON.stringify({ providers: {} }),
    ".pi/agent/AGENTS.md": `${POISON} global agents`,
    ".pi/agent/APPEND_SYSTEM.md": `${POISON} global append`,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), content);
  }
}

export function usePoisonedWorkspace() {
  beforeEach(async () => {
    workspace.root = await mkdtemp(join(tmpdir(), "pi-sdk-proof-"));
    workspace.home = join(workspace.root, "home");
    workspace.cwd = join(workspace.root, "work");
    workspace.agentDir = join(workspace.root, "agent");
    await seedPoison(workspace.home);
    await seedPoison(workspace.cwd);
    await mkdir(workspace.agentDir);
    previousHome = process.env.HOME;
    process.env.HOME = workspace.home;
  });

  afterEach(async () => {
    for (const created of sessions.splice(0)) created.dispose();
    for (const started of fixtures.splice(0)) await started.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(workspace.root, { recursive: true, force: true });
  });
}

export function track(created: AgentSession) {
  sessions.push(created);
  return created;
}

export async function fixture(protocol: WireProtocol, steps: WireStep[]) {
  const started = await startWireFixture({ protocol, steps });
  fixtures.push(started);
  return started;
}

export async function session(
  wire: WireFixture,
  options: Omit<Parameters<typeof createProofSession>[0], "cwd" | "agentDir" | "runtime"> = {
    systemPrompt: "Fixture system.",
  },
) {
  return track(
    await createProofSession({
      cwd: workspace.cwd,
      agentDir: workspace.agentDir,
      runtime: await proofModelRuntime(wire, KEY),
      ...options,
    }),
  );
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const text =
  (value: string): WireStep =>
  () => ({
    type: "message",
    blocks: [{ type: "text", text: value }],
  });
export const calls =
  (...names: string[]): WireStep =>
  () => ({
    type: "message",
    blocks: names.map((name) => ({ type: "tool", id: `call-${name}`, name, arguments: {} })),
  });

export function tool(
  name: string,
  execute: ToolDefinition["execute"],
  extra: Partial<ToolDefinition> = {},
): ToolDefinition {
  return { name, label: name, description: name, parameters: Type.Object({}), execute, ...extra };
}
export const done = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: {},
});

export function persisted(target: AgentSession) {
  return target.sessionManager.buildSessionContext().messages.flatMap(lines);
}
export function lines(message: AgentMessage): string[] {
  if (message.role === "user") {
    const value =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    return [`user: ${value}`];
  }
  if (message.role === "toolResult") {
    return [
      `tool ${message.toolCallId}: ${message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")}`,
    ];
  }
  if (message.role === "assistant") {
    return message.content.flatMap((part) =>
      part.type === "text"
        ? [`assistant: ${part.text}`]
        : part.type === "toolCall"
          ? [`call ${part.id} ${part.name} ${JSON.stringify(part.arguments)}`]
          : [],
    );
  }
  return [];
}

export function steeringStore() {
  const items: Array<AgentSteeringMessage & { claimed: boolean }> = [];
  const claims: string[][] = [];
  return {
    claims,
    add(value: string) {
      const id = `s${items.length + 1}`;
      items.push({ id, messageId: `m-${id}`, text: value, claimed: false });
    },
    unclaimed: () => items.filter((item) => !item.claimed).map((item) => item.text),
    async claim(seenIds: string[]) {
      claims.push(seenIds);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const fresh = items.filter((item) => !item.claimed && !seenIds.includes(item.id));
      for (const item of fresh) item.claimed = true;
      return fresh.map(({ claimed: _claimed, ...item }) => item);
    },
  };
}

export async function settledWithin<T>(ms: number, work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
