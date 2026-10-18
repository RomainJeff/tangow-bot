import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LiveEvalArm } from "./pi-live-eval-arms.js";
import { LIVE_EVAL_ARMS, LIVE_EVAL_SETTLE_MS, runLiveEvalArm } from "./pi-live-eval-arms.js";
import type { LiveEvalTask } from "./pi-live-eval-tasks.js";
import { createLiveEvalTask } from "./pi-live-eval-tasks.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";
import type { WireBlock, WireFixture, WireStep, WireUsage } from "./pi-sdk-proof-support.js";
import { proofModelRuntime } from "./pi-sdk-proof-support.js";
import { fixture, KEY, usePoisonedWorkspace, workspace } from "./pi-sdk-test-support.js";

const SEEDS = [1, 7, 20261018];
const USAGE: WireUsage = { input: 11, output: 7, cacheRead: 5, cacheWrite: 0 };

function rows(csv: string | undefined): Record<string, string>[] {
  const [header = "", ...lines] = (csv ?? "").trim().split("\n");
  const keys = header.split(",");
  return lines.map((line) =>
    Object.fromEntries(line.split(",").map((value, i) => [keys[i], value])),
  );
}

function solveReconcile(files: ReadonlyMap<string, string>) {
  const orders = new Map(rows(files.get("data/orders.csv")).map((row) => [row.order_id, row]));
  const payments = rows(files.get("data/payments.csv"));
  const refunds = rows(files.get("data/refunds.csv"));
  const discrepancies: { order_id: string; kind: string }[] = [];
  const add = (order_id = "", kind: string) => {
    if (!discrepancies.some((entry) => entry.order_id === order_id && entry.kind === kind)) {
      discrepancies.push({ order_id, kind });
    }
  };
  for (const [id, order] of orders) {
    const paid = payments.filter((payment) => payment.order_id === id);
    const [only] = paid;
    if (!only) add(id, "missing_payment");
    else if (paid.length > 1) add(id, "duplicate_payment");
    else if (only.currency !== order.currency) add(id, "currency_mismatch");
    else if (Number(only.amount) !== Number(order.amount)) add(id, "amount_mismatch");
    const refunded = refunds
      .filter((refund) => refund.order_id === id)
      .reduce((sum, refund) => sum + Number(refund.amount), 0);
    if (refunded > Number(order.amount)) add(id, "over_refund");
  }
  for (const payment of payments)
    if (!orders.has(payment.order_id)) add(payment.order_id, "orphan_payment");
  for (const refund of refunds)
    if (!orders.has(refund.order_id)) add(refund.order_id, "orphan_refund");
  return { discrepancies };
}

interface Service {
  id: string;
  tier: number;
  replicas: number;
  depends_on: string[];
}

function repairConfig(files: ReadonlyMap<string, string>): Map<string, string> {
  const repaired = new Map(files);
  const services = [...files]
    .filter(([path]) => path.startsWith("services/"))
    .map(([path, text]): [string, Service] => [path, JSON.parse(text)]);
  const ids = services.map(([, service]) => service.id);
  const known = (id: string) =>
    ids.includes(id) ? id : ids.find((candidate) => candidate.startsWith(id));
  const tierOf = new Map(services.map(([, service]) => [service.id, service.tier]));
  for (const [path, service] of services) {
    const depends_on = service.depends_on
      .map((id) => known(id) ?? id)
      .filter((id) => (tierOf.get(id) ?? Number.POSITIVE_INFINITY) < service.tier);
    const replicas = Math.min(6, Math.max(2, service.replicas));
    repaired.set(path, `${JSON.stringify({ ...service, replicas, depends_on }, null, 2)}\n`);
  }
  const routes: { routes: { path: string; service: string }[] } = JSON.parse(
    files.get("routes.json") ?? "",
  );
  const fixedRoutes = routes.routes.map((route) => ({
    ...route,
    service: known(route.service) ?? route.service,
  }));
  repaired.set("routes.json", JSON.stringify({ routes: fixedRoutes }));
  return repaired;
}

const seedFiles = (task: LiveEvalTask) => new Map(Object.entries(task.files));
const withFile = (files: ReadonlyMap<string, string>, path: string, text: string) =>
  new Map(files).set(path, text);

describe.each(SEEDS)("live eval tasks with seed %i", (seed) => {
  it("plants seven reconcilable discrepancies and grades only the exact set", () => {
    const task = createLiveEvalTask("reconcile", seed);
    const seeded = seedFiles(task);
    const answer = solveReconcile(seeded);
    expect(answer.discrepancies).toHaveLength(7);
    for (const { order_id } of answer.discrepancies) expect(task.prompt).not.toContain(order_id);
    const solved = withFile(seeded, "report.json", JSON.stringify(answer));
    expect(task.check(solved)).toEqual([]);
    expect(task.grade(solved)).toEqual({ passed: true, score: 1, findings: [] });

    expect(task.grade(seeded).passed).toBe(false);
    expect(task.check(withFile(seeded, "report.json", "{"))).not.toEqual([]);
    const shotgun = [...(seeded.get("data/orders.csv") ?? "").matchAll(/O-\d{4}/g)].flatMap(
      ([id]) => ["missing_payment", "amount_mismatch"].map((kind) => ({ order_id: id, kind })),
    );
    const shotgunGrade = task.grade(
      withFile(seeded, "report.json", JSON.stringify({ discrepancies: shotgun })),
    );
    expect(shotgunGrade.passed).toBe(false);
    expect(shotgunGrade.score).toBeLessThan(0.1);
    const partial = { discrepancies: answer.discrepancies.slice(1) };
    expect(task.grade(withFile(seeded, "report.json", JSON.stringify(partial))).passed).toBe(false);
    const tampered = withFile(solved, "data/payments.csv", "payment_id,order_id,currency,amount\n");
    expect(task.grade(tampered).passed).toBe(false);
  });

  it("repairs config only through the policy's unique fixes", () => {
    const task = createLiveEvalTask("config-repair", seed);
    const seeded = seedFiles(task);
    expect(task.check(seeded)).toHaveLength(4);
    expect(task.grade(seeded)).toMatchObject({ passed: false, score: 0 });
    const repaired = repairConfig(seeded);
    expect(task.check(repaired)).toEqual([]);
    expect(task.grade(repaired)).toEqual({ passed: true, score: 1, findings: [] });

    const [servicePath, serviceText = ""] =
      [...repaired].find(([path]) => path.startsWith("services/")) ?? [];
    const service: Service = JSON.parse(serviceText);
    const retiered = withFile(repaired, servicePath ?? "", JSON.stringify({ ...service, tier: 9 }));
    expect(task.grade(retiered).passed).toBe(false);
    const deleted = new Map(repaired);
    deleted.delete(servicePath ?? "");
    expect(task.check(deleted)).not.toEqual([]);
    expect(task.grade(deleted).passed).toBe(false);
    expect(
      task.grade(withFile(repaired, "routes.json", JSON.stringify({ routes: [] }))).passed,
    ).toBe(false);
    expect(task.grade(withFile(repaired, "notes.md", "done")).passed).toBe(false);

    const services = [...repaired].filter(([path]) => path.startsWith("services/"));
    const [clampedPath = "", clampedText = ""] =
      services.find(([path]) => {
        const { replicas }: Service = JSON.parse(seeded.get(path) ?? "");
        return replicas < 2 || replicas > 6;
      }) ?? [];
    const clamped: Service = JSON.parse(clampedText);
    const unclamped = withFile(repaired, clampedPath, JSON.stringify({ ...clamped, replicas: 4 }));
    const undepended = new Map(repaired);
    for (const [path, text] of services) {
      undepended.set(path, JSON.stringify({ ...JSON.parse(text), depends_on: [] }));
    }
    const { routes } = JSON.parse(repaired.get("routes.json") ?? "");
    const [first, second] = routes;
    const repointed = withFile(
      repaired,
      "routes.json",
      JSON.stringify({ routes: [{ ...first, service: second.service }, ...routes.slice(1)] }),
    );
    for (const wrong of [unclamped, undepended, repointed]) {
      expect(task.check(wrong)).toEqual([]);
      expect(task.grade(wrong).passed).toBe(false);
    }
  });
});

const toolStep =
  (calls: { name: string; arguments: Record<string, unknown> }[]): WireStep =>
  () => ({
    type: "message",
    usage: USAGE,
    blocks: calls.map((call, index): WireBlock => ({ type: "tool", id: `call-${index}`, ...call })),
  });
const finalStep: WireStep = () => ({
  type: "message",
  usage: USAGE,
  blocks: [{ type: "text", text: "Done." }],
});

async function armInput(
  arm: LiveEvalArm,
  wire: WireFixture,
  task: LiveEvalTask,
  signal = new AbortController().signal,
) {
  return {
    arm,
    task,
    cwd: workspace.cwd,
    agentDir: workspace.agentDir,
    signal,
    models: {
      runtime: {
        provider: OPENAI_COMPATIBLE_PROVIDER_ID,
        id: "proof-model",
        baseUrl: wire.baseUrl,
        apiKey: KEY,
        maxTokens: 4_096,
        thinkingLevel: "off" as const,
      },
      sdk: await proofModelRuntime(wire, KEY),
    },
  };
}

function reportEdit(arm: LiveEvalArm, oldText: string, newText: string) {
  return arm === "sdk-native-files"
    ? { name: "edit", arguments: { path: "report.json", edits: [{ oldText, newText }] } }
    : {
        name: "edit_file",
        arguments: { path: "report.json", old_text: oldText, new_text: newText },
      };
}

function escapeCalls(arm: LiveEvalArm, report: string) {
  const outside = join(workspace.root, "escape.txt");
  const [read, write] =
    arm === "sdk-native-files" ? ["read", "write"] : ["read_file", "write_file"];
  const edit =
    arm === "sdk-native-files"
      ? {
          name: "edit",
          arguments: { path: "../escape.txt", edits: [{ oldText: "a", newText: "b" }] },
        }
      : { name: "edit_file", arguments: { path: "../escape.txt", old_text: "a", new_text: "b" } };
  return {
    outside,
    calls: [
      { name: read, arguments: { path: "/etc/hosts" } },
      { name: read, arguments: { path: "AGENTS.md" } },
      { name: read, arguments: { path: "~/.pi/agent/auth.json" } },
      { name: write, arguments: { path: outside, content: "escaped" } },
      edit,
      { name: write, arguments: { path: "report.json", content: report } },
    ],
  };
}

usePoisonedWorkspace();

describe.each(LIVE_EVAL_ARMS)("live eval arm %s", (arm) => {
  it("keeps every tool inside the virtual workspace and grades the artifact", async () => {
    const task = createLiveEvalTask("reconcile", 3);
    const report = JSON.stringify(solveReconcile(seedFiles(task)));
    const draft = report.replace("missing_payment", "TODO");
    const { outside, calls } = escapeCalls(arm, draft);
    const wire = await fixture("openai-completions", [
      toolStep(calls),
      toolStep([reportEdit(arm, "TODO", "missing_payment")]),
      finalStep,
    ]);
    const result = await runLiveEvalArm(await armInput(arm, wire, task));
    wire.assertComplete();

    expect(result).toMatchObject({ status: "completed", done: true, errors: [], settleMs: null });
    expect(result.grade.passed).toBe(true);
    expect([...result.artifacts.keys()].sort()).toEqual(
      [...Object.keys(task.files), "report.json"].sort(),
    );
    expect(result.metrics).toMatchObject({
      modelTurns: 3,
      toolCalls: 7,
      toolErrors: 5,
      usage: { input: 33, output: 21, cacheRead: 15, cacheWrite: 0 },
      costUSD: 0,
    });
    expect(result.metrics.firstTokenMs).not.toBeNull();
    expect(existsSync(outside)).toBe(false);
    const toolResults =
      wire.requests[1]?.transcript.filter((line) => line.startsWith("tool ")).join("\n") ?? "";
    expect(toolResults).not.toContain(await readFile(join(workspace.cwd, "AGENTS.md"), "utf8"));
    expect(toolResults).not.toContain(
      await readFile(join(workspace.home, ".pi/agent/auth.json"), "utf8"),
    );
    const expectedTools =
      arm === "sdk-native-files"
        ? ["edit", "list_files", "read", "run_check", "write"]
        : ["edit_file", "list_files", "read_file", "run_check", "write_file"];
    expect([...(wire.requests[0]?.tools ?? [])].sort()).toEqual(expectedTools);
  });

  it("stops at the deadline and settles the engine within the bound", async () => {
    const task = createLiveEvalTask("config-repair", 3);
    const wire = await fixture("openai-completions", [() => ({ type: "hold", blocks: [] })]);
    const result = await runLiveEvalArm({ ...(await armInput(arm, wire, task)), deadlineMs: 100 });
    wire.assertComplete();

    expect(result.status).toBe("deadline");
    expect(result.metrics.costUSD).toBeNull();
    expect(result.errors).not.toContain("unsettled");
    expect(result.settleMs).toBeLessThanOrEqual(LIVE_EVAL_SETTLE_MS);
    expect(result.grade.passed).toBe(false);
    await vi.waitFor(() => expect(wire.openResponses()).toBe(0));
  });
});

it("caps each arm at the shared tool budget", async () => {
  const task = createLiveEvalTask("config-repair", 3);
  const listing = Array.from({ length: 41 }, () => ({
    name: "list_files",
    arguments: { path: "services" },
  }));
  const wire = await fixture("openai-completions", [toolStep(listing)]);
  const result = await runLiveEvalArm(await armInput("sdk-same-tools", wire, task));
  wire.assertComplete();

  expect(result.status).toBe("tool_budget");
  expect(result.metrics.toolCalls).toBe(40);
  expect(result.errors).not.toContain("unsettled");
});
