import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { ManagedSandboxEmulator } from "@rakazo/adapters";
import { HARNESSES } from "@rakazo/agent-run-worker";
import { afterEach, expect, it, vi } from "vitest";
import { dockerE2BMachine } from "../../adapters/src/e2b-machine.test-support.js";
import { E2BSandboxProvider } from "../../adapters/src/e2b-sandbox.js";
import { latestCard } from "./index.js";
import type { ModelEmulatorStep } from "./model-emulator.js";
import { startWorkerRun } from "./worker-run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.skipIf(process.env.VERIFY_DOCKER_TEAM_SCREENS !== "1")(
  "retains the original Chrome document and refs through native worker approval retirement",
  async () => {
    const machine = await dockerE2BMachine(
      process.env.COMPUTER_TEST_IMAGE ?? "rakazo/computer:local",
    );
    cleanups.push(() => machine.close());
    const helper = await machine.exec("sha256sum /usr/local/bin/rakazo-page-browser");
    const bytes = await readFile(
      new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url),
    );
    expect(helper.stdout.split(" ")[0]).toBe(createHash("sha256").update(bytes).digest("hex"));
    const html = `<title>Pending approval</title><label>Note<input></label><button onclick="document.title='Approved '+(++window.effects);fetch('/submit',{method:'POST'})">Submit</button><script>window.effects=0</script>`;
    const server = `from http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(${JSON.stringify(html)}.encode())\n def do_POST(self):\n  with open('/tmp/approval-submissions','a') as f:f.write('submit\\n')\n  self.send_response(200);self.end_headers()\nHTTPServer(('127.0.0.1',8123),H).serve_forever()`;
    const encoded = Buffer.from(server).toString("base64");
    expect(
      (
        await machine.exec(
          `printf '%s' '${encoded}' | base64 -d >/tmp/approval-form.py; python3 /tmp/approval-form.py >/tmp/approval-form.log 2>&1 </dev/null &`,
        )
      ).exitCode,
    ).toBe(0);
    const page = new E2BSandboxProvider("offline-test", machine.sdk);
    let actions: Array<{ kind: "fill" | "click"; ref: string; text?: string }> = [];
    const releases: string[] = [];
    const effects: unknown[] = [];
    class Computer extends ManagedSandboxEmulator {
      async pageBrowser(...args: Parameters<NonNullable<SandboxProvider["pageBrowser"]>>) {
        const result = await page.pageBrowser(...args);
        if (args[1].command === "snapshot") {
          const input = result.elements?.find((element) => element.name === "Note");
          const button = result.elements?.find((element) => element.name === "Submit");
          expect(input).toBeDefined();
          expect(button).toBeDefined();
          actions = [
            { kind: "fill", ref: input!.ref, text: "Approved note" },
            { kind: "click", ref: button!.ref },
          ];
        }
        if (args[1].command === "act") effects.push(result);
        return result;
      }
      override async releaseScreen(computer: ComputerRef, context: AdapterContext) {
        releases.push(context.screenLeaseId!);
        await page.releaseScreen(computer, context);
        await super.releaseScreen(computer, context);
      }
    }
    const steps: ModelEmulatorStep[] = [
      {
        expect() {},
        response: {
          type: "tool",
          id: "navigate",
          name: "browser_navigate",
          arguments: { url: "http://127.0.0.1:8123/" },
        },
      },
      {
        expect() {},
        response: { type: "tool", id: "snapshot", name: "browser_snapshot", arguments: {} },
      },
      {
        expect() {},
        response: () => ({
          type: "tool",
          id: "submit",
          name: "browser_act",
          arguments: { actions },
        }),
      },
      { expect() {}, response: { type: "text", text: "Waiting." } },
      {
        expect() {},
        response: {
          type: "tool",
          id: "say",
          name: "message_user",
          arguments: { message: "Done." },
        },
      },
      {
        expect() {},
        response: {
          type: "text",
          text: JSON.stringify({ version: 1, results: ["Submitted"], references: [] }),
        },
      },
    ];
    const run = await startWorkerRun({
      steps,
      sandbox: new Computer(),
      computerScope: "team",
      protocol: "anthropic",
      harness: HARNESSES["pi-native"]!,
    });
    cleanups.push(() => run.close());
    await run.prisma.actionApprovalRule.create({
      data: {
        spaceId: run.spaceId,
        createdByUserId: run.userId,
        effect: "require_approval",
        matchKind: "tool",
        matchValue: "browser_act",
      },
    });
    const id = await run.send("Submit the synthetic note after approval.");
    await run.continueRun(id);
    const paused = await run.prisma.run.findUniqueOrThrow({ where: { id } });
    expect(paused.status).toBe("waiting_input");
    expect(effects).toEqual([]);
    expect(releases).toEqual([]);
    expect((await machine.exec("test ! -e /tmp/approval-submissions")).exitCode).toBe(0);
    const pid = await machine.exec("cat /tmp/rakazo/browser-pid-*");
    expect(pid.exitCode).toBe(0);
    expect(run.provider.launches).toHaveLength(1);
    const card = await latestCard(run.prisma, id);
    expect(
      await run.events.answerRunInput({
        spaceId: run.spaceId,
        threadId: run.thread.id,
        runId: id,
        messageId: card.id,
        answeredByUserId: run.userId,
        answer: "allow",
      }),
    ).toBe(true);
    // Observe the physical browser at the approved dispatch, before terminal release.
    const act = page.pageBrowser.bind(page);
    let resumedPid = "";
    vi.spyOn(page, "pageBrowser").mockImplementation(async (...args) => {
      resumedPid = (await machine.exec("cat /tmp/rakazo/browser-pid-*")).stdout;
      return act(...args);
    });
    run.restart();
    await run.continueRun(id);
    expect(await run.prisma.run.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: "completed",
      checkpoint: null,
    });
    expect(resumedPid).toBe(pid.stdout);
    expect(effects).toEqual([
      expect.objectContaining({ ok: true, completed: 2, title: "Approved 1" }),
    ]);
    expect((await machine.exec("cat /tmp/approval-submissions")).stdout).toBe("submit\n");
    expect(run.provider.launches).toHaveLength(1);
    expect(await run.prisma.attempt.count({ where: { runId: id } })).toBe(2);
    expect(releases).toHaveLength(1);
    expect(
      (
        await machine.exec(
          "test -z \"$(find /tmp/rakazo/desktop-assignments -name '*.slot' -print)\"; ! curl -fsS http://127.0.0.1:9241/json/version >/dev/null 2>&1",
        )
      ).exitCode,
    ).toBe(0);
    run.model.assertComplete();
  },
  120_000,
);
