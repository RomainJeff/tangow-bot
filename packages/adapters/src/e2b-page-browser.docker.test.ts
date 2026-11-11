import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  managedDesktopOperationCommand,
  shellQuote,
  stopAllDesktopBrowsersCommand,
} from "@tangow/core/node/desktop-runtime";
import { describe, expect, it } from "vitest";
import { dockerE2BMachine } from "./e2b-machine.test-support.js";
import { E2BSandboxProvider } from "./e2b-sandbox.js";

const context = {
  operationId: "browser-proof",
  traceId: "browser-proof",
  userId: "user",
  spaceId: "space",
  botId: "bot",
  screenLeaseId: "run:1",
  signal: new AbortController().signal,
};
const computer = { id: "machine", providerRef: "machine", kind: "e2b" as const, botId: "home" };
const image = process.env.RAKAZO_COMPUTER_IMAGE ?? "rakazo/computer:local";
const environment = {
  homeDir: "/home/user",
  workspaceDir: "/home/user/rakazo-home",
  browserProfilesDir: "/home/user/rakazo-home/.browser-profiles",
  displayStart: 20,
  portStart: 6100,
};
const key = createHash("sha256").update("bot").digest("hex").slice(0, 32);
const registry = `/tmp/rakazo/desktop-assignments/${key}`;

async function ready(f: Awaited<ReturnType<typeof dockerE2BMachine>>, command: string) {
  const result = await f.exec(
    `for i in $(seq 1 200); do if ${command}; then exit 0; fi; sleep 0.025; done; exit 1`,
  );
  expect(result.exitCode, result.stderr).toBe(0);
}

describe.skipIf(process.env.VERIFY_DOCKER_TEAM_SCREENS !== "1")(
  "E2B browser on canonical Linux",
  () => {
    it("navigates, snapshots, fills and clicks the same visible Chrome as computer actions", async () => {
      const f = await dockerE2BMachine(image);
      try {
        const localHelper = await readFile(
          new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url),
        );
        expect(
          (await f.exec("sha256sum /usr/local/bin/rakazo-page-browser")).stdout.split(" ")[0],
        ).toBe(createHash("sha256").update(localHelper).digest("hex"));
        const html =
          "<title>Browser form</title><h1>Browser agreement</h1><label>Name<input id=\"name\"></label><button onclick=\"document.title='Saved '+document.querySelector('#name').value;document.querySelector('h1').textContent=document.title\">Save</button>";
        const server = `from http.server import BaseHTTPRequestHandler, HTTPServer\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(${JSON.stringify(html)}.encode())\nHTTPServer(('127.0.0.1',8123),Handler).serve_forever()`;
        expect(
          (await f.exec(`python3 -c ${shellQuote(server)} </dev/null >/tmp/form.log 2>&1 &`))
            .exitCode,
        ).toBe(0);
        const provider = new E2BSandboxProvider("test-key", f.sdk);
        await provider.act(
          computer,
          {
            actions: [{ kind: "launch", application: "browser", uri: "http://127.0.0.1:8123" }],
            observe: false,
          },
          context,
        );
        await ready(f, "curl -fsS http://127.0.0.1:9241/json/version >/dev/null");
        const navigate = await provider.pageBrowser(
          computer,
          { command: "navigate", url: "http://127.0.0.1:8123/form" },
          context,
        );
        expect(navigate).toMatchObject({ ok: true, title: "Browser form" });
        const before = await provider.pageBrowser(computer, { command: "snapshot" }, context);
        expect(before.ok).toBe(true);
        const name = before.elements?.find((node) => node.name === "Name");
        const save = before.elements?.find((node) => node.name === "Save");
        expect(name?.ref).toBeTruthy();
        expect(save?.ref).toBeTruthy();
        const acted = await provider.pageBrowser(
          computer,
          {
            command: "act",
            actions: [
              { kind: "fill", ref: name!.ref, text: "Ada" },
              { kind: "click", ref: save!.ref },
            ],
          },
          context,
        );
        expect(acted).toMatchObject({ ok: true, completed: 2, title: "Saved Ada" });
        expect(acted.tree).toContain("Saved Ada");
        await ready(f, "DISPLAY=:20 xdotool getactivewindow getwindowname | grep -q 'Saved Ada'");
        const observation = await provider.observe(computer, context);
        expect(observation.image.length).toBeGreaterThan(1000);
        if (process.env.COMPUTER_BROWSER_PROOF_PNG)
          await writeFile(process.env.COMPUTER_BROWSER_PROOF_PNG, observation.image);
      } finally {
        await f.close();
      }
    }, 120_000);

    it("refuses release/reallocation before dispatch and while the command is unarmed", async () => {
      const f = await dockerE2BMachine(image);
      try {
        const provider = new E2BSandboxProvider("test-key", f.sdk);
        await provider.observe(computer, context);
        f.setBeforePermit(async () => {
          await provider.releaseScreen(computer, context);
          await provider.observe(computer, {
            ...context,
            botId: "other",
            screenLeaseId: "other:2",
          });
        });
        const result = await provider.pageBrowser(
          computer,
          { command: "navigate", url: "http://127.0.0.1:8123/must-not-navigate" },
          context,
        );
        expect(result).toMatchObject({ ok: false, fallback: "computer_act" });
        expect((await f.exec(`test ! -f ${registry}.slot`)).exitCode).toBe(0);
        // A greater fence must not resurrect an absent slot or supersede a current lease.
        for (const slot of ["", "0\nnew:2\nview-token\n"]) {
          await f.exec(
            slot ? `printf %s ${shellQuote(slot)} >${registry}.slot` : `rm -f ${registry}.slot`,
          );
          const operation = managedDesktopOperationCommand(
            "bot",
            "run:3",
            environment,
            ["touch", "/tmp/forbidden"],
            1000,
          );
          const denied = await f.exec(
            `printf 'RAKAZO_DESKTOP_OPERATION\n' | bash -c ${shellQuote(operation)}`,
          );
          expect(denied.exitCode).toBe(75);
        }
        expect((await f.exec("test ! -e /tmp/forbidden")).exitCode).toBe(0);
        const unarmed = managedDesktopOperationCommand(
          "bot",
          "run:1",
          environment,
          ["touch", "/tmp/forbidden"],
          150,
        );
        const expired = await f.exec(`sleep 0.5 | bash -c ${shellQuote(unarmed)}`);
        expect([124, 137]).toContain(expired.exitCode);
        expect((await f.exec("test ! -e /tmp/forbidden")).exitCode).toBe(0);
      } finally {
        await f.close();
      }
    }, 120_000);

    it("terminates an armed blocked helper and a lock waiter on cancellation", async () => {
      const f = await dockerE2BMachine(image);
      try {
        const provider = new E2BSandboxProvider("test-key", f.sdk);
        await provider.observe(computer, context);
        // The fixed helper path remains real; a loopback CDP peer accepts and never responds.
        const blocked =
          "import socket,time\ns=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',9241));s.listen();open('/tmp/listening','w').close();c,a=s.accept();time.sleep(60)";

        for (const lockWait of [false, true]) {
          const controller = new AbortController();
          if (!lockWait) {
            f.setBeforePermit(async () => {
              await f.exec(stopAllDesktopBrowsersCommand(environment));
              await f.exec(`python3 -c ${shellQuote(blocked)} </dev/null >/tmp/blocked.log 2>&1 &`);
              await ready(f, "test -f /tmp/listening");
            });
          } else {
            f.setBeforePermit(async () => {
              await f.exec(
                `flock ${registry}.lifecycle-lock sh -c 'touch /tmp/locked; sleep 60' </dev/null >/tmp/lock.log 2>&1 &`,
              );
              await ready(f, "test -f /tmp/locked");
            });
          }
          const operation = provider.pageBrowser(
            computer,
            { command: "snapshot" },
            { ...context, signal: controller.signal },
          );
          await ready(
            f,
            lockWait
              ? `pgrep -f '^flock -w .* 8$' >/dev/null`
              : "pgrep -f '^python3 /usr/local/bin/rakazo-page-browser snapshot' >/dev/null",
          );
          const pid = f.pid;
          if (!lockWait) {
            const release = await f.exec(`flock -n ${registry}.lifecycle-lock true`);
            expect(release.exitCode).toBe(1);
          }
          controller.abort();
          await expect(operation).rejects.toThrow();
          await ready(
            f,
            `! ps -eo pgid=,stat= | awk '$1 == ${pid} && $2 !~ /^Z/ { found=1 } END { exit !found }'`,
          );
          expect(
            (await f.exec("pgrep -f '^python3 /usr/local/bin/rakazo-page-browser' || true")).stdout,
          ).toBe("");
        }
      } finally {
        await f.close();
      }
    }, 120_000);
  },
);
