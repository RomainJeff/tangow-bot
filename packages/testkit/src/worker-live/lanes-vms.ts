import path from "node:path";
import { WORKSPACE_ROOT } from "@rakazo/core";
import { Sandbox } from "e2b";
import { toolResult } from "../file-task.js";
import { call, finish, liveRun } from "./run.js";
import { COMPUTER_WORKSPACE, type Lane, POLL_INTERVAL_S, pollFor, sh } from "./session.js";

/**
 * Guest read, write, edit, grep and bash against files a computer wrote on both volumes, and
 * writes of its own for the computer to see. `results` collects each tool's output.
 */
function exchangeSteps(results: Record<string, string>) {
  return [
    call("r1", "read_file", { path: "from-computer.txt" }),
    call("r2", "read_file", { path: "shared/from-computer.txt" }, (request) => {
      results.readPrivate = toolResult(request);
    }),
    call(
      "w1",
      "write_file",
      { path: "from-worker.txt", content: "draft by the worker\n" },
      (request) => {
        results.readShared = toolResult(request);
      },
    ),
    call(
      "e1",
      "edit_file",
      { path: "from-worker.txt", old_text: "draft", new_text: "edited" },
      (request) => {
        results.write = toolResult(request);
      },
    ),
    call("g1", "grep", { pattern: "edited|computer" }, (request) => {
      results.edit = toolResult(request);
    }),
    call(
      "b1",
      "bash",
      {
        command:
          "echo 'shared by the worker' > /workspace/shared/from-worker.txt && cat from-computer.txt",
      },
      (request) => {
        results.grep = toolResult(request);
      },
    ),
    ...finish("Exchanged files with the computer", (request) => {
      results.bash = toolResult(request);
    }),
  ];
}

/**
 * Writes the computer's files at `privateDir` and `sharedDir`, runs the exchange, and polls for the
 * guest's writes from the computer.
 */
async function exchange(
  worker: Awaited<ReturnType<typeof liveRun>>,
  computer: Sandbox,
  results: Record<string, string>,
  privateDir: string,
  sharedDir: string,
) {
  await computer.files.write(`${privateDir}/from-computer.txt`, "written by the computer\n");
  await computer.files.write(`${sharedDir}/from-computer.txt`, "shared by the computer\n");
  const privateSeen = pollFor(computer, `${privateDir}/from-worker.txt`, "edited by the worker");
  const sharedSeen = pollFor(computer, `${sharedDir}/from-worker.txt`, "shared by the worker");
  const runId = await worker.send("Exchange files with the computer.");
  await worker.completed(runId);
  const [mine, shared] = await Promise.all([privateSeen, sharedSeen]);
  const grants = worker
    .frames()
    .filter((frame) => frame.from === "controller" && frame.type === "tool.grant");
  /** From the grant of the guest tool that wrote, the last one before the computer saw it. */
  const sinceGrant = (seenAt: number) =>
    Math.round(seenAt - (grants.filter((grant) => grant.at < seenAt).at(-1)?.at ?? Number.NaN));
  const pass =
    (await worker.status(runId)) === "completed" &&
    results.readPrivate?.includes("written by the computer") === true &&
    results.readShared?.includes("shared by the computer") === true &&
    results.edit?.includes('"replacements":1') === true &&
    results.grep?.includes("from-worker.txt:1:edited by the worker") === true &&
    results.grep?.includes("from-computer.txt:1:written by the computer") === true &&
    results.bash?.includes("written by the computer") === true &&
    mine.out.startsWith("seen") &&
    shared.out.startsWith("seen");
  return {
    pass,
    observed: {
      guestToolResults: results,
      computerSawPrivateWrite: mine.out,
      computerSawSharedWrite: shared.out,
      privateVisibleWithinMsOfGrant: sinceGrant(mine.at),
      sharedVisibleWithinMsOfGrant: sinceGrant(shared.at),
      pollIntervalMs: POLL_INTERVAL_S * 1000,
      note: "Visibility times run from the controller granting the guest tool that wrote to the host seeing the computer's poller exit. They include the tool's own run and E2B's command stream, so they bound the cross-VM delay from above.",
    },
  };
}

export const laneB: Lane = {
  id: "b",
  issue: "read/write/edit/grep locaux et visibilité computer dans les deux sens",
  scenario:
    "Guest read, write, edit, grep and bash on the private and shared volumes, with a second VM of the computer template mounting the same volumes",
  passWhen:
    "The guest reads what the computer wrote, and the computer sees by polling what the guest wrote, on both volumes",
  async run(live) {
    const results: Record<string, string> = {};
    const worker = await liveRun(live, { computer: "team", steps: exchangeSteps(results) });
    const computer = await live.vm(worker.mounts());
    try {
      return await exchange(worker, computer, results, worker.privateMount, worker.sharedMount);
    } finally {
      await computer.kill().catch(() => false);
      await worker.close();
    }
  },
};

export const laneBProductComputer: Lane = {
  id: "b-product-computer",
  issue: "visibilité computer dans les deux sens (computer produit)",
  scenario:
    "Lane b's exchange with the product's E2B computer of a team bot: a first run boots it through the executor with the volumes mounted, and the second run's guest exchanges files with it through its workspace link",
  passWhen:
    "The first run's computer mounts the volumes and links its workspace to their root; the second run reuses that machine; the computer sees the guest's writes and the guest sees the computer's, on both volumes",
  async run(live) {
    const results: Record<string, string> = {};
    const worker = await liveRun(live, {
      computer: "team",
      sandbox: live.computer(),
      steps: [...finish("Ready"), ...exchangeSteps(results)],
    });
    let computer: Sandbox | undefined;
    try {
      const machine = async () =>
        (await worker.run.prisma.computer.findFirstOrThrow({ select: { providerRef: true } }))
          .providerRef;
      const ready = await worker.send("Get ready.");
      if ((await worker.status(ready)) !== "completed")
        throw new Error("The first run, which boots the computer, did not complete");
      const first = await machine();
      if (!first) throw new Error("The first run left the computer without a machine");
      computer = await Sandbox.connect(first, live.connection);
      const info = await Sandbox.getInfo(first, live.connection);
      const link = await sh(computer, `readlink ${COMPUTER_WORKSPACE}`);
      const mounted = await sh(
        computer,
        `findmnt -rn -o TARGET | grep '^${WORKSPACE_ROOT}/' | sort`,
      );
      const inComputer = (mount: string) =>
        path.posix.join(COMPUTER_WORKSPACE, path.posix.relative(WORKSPACE_ROOT, mount));
      const exchanged = await exchange(
        worker,
        computer,
        results,
        inComputer(worker.privateMount),
        inComputer(worker.sharedMount),
      );
      const second = await machine();
      const expectedMounts = [worker.privateMount, worker.sharedMount].sort().join("\n");
      return {
        pass:
          exchanged.pass &&
          info.metadata.home === "volumes" &&
          Boolean(info.metadata.mounts) &&
          link === WORKSPACE_ROOT &&
          mounted === expectedMounts &&
          second === first,
        observed: {
          ...exchanged.observed,
          computerMetadataHome: info.metadata.home,
          computerRecordsMountSet: Boolean(info.metadata.mounts),
          workspaceLinksTo: link,
          volumeMountsInComputer: mounted.split("\n"),
          secondRunReusedMachine: second === first,
          desktopPreparation: "skipped: this host has no desktop template",
        },
      };
    } finally {
      await worker.close();
    }
  },
};

export const laneC: Lane = {
  id: "c",
  issue: "PID et localhost distincts",
  scenario:
    "A listener on 127.0.0.1 in the computer and one in the worker, each probed from the other VM, with the kernels' boot ids and process lists compared",
  passWhen:
    "Each listener answers and is listed in its own VM, and is refused and absent from the process list in the other; the boot ids differ",
  async run(live) {
    const listener = (title: string, port: number, reply: string) =>
      `node -e "process.title='${title}'; require('net').createServer((s) => s.end('${reply}')).listen(${port}, '127.0.0.1')"`;
    const probe = (port: number) =>
      `(exec 3<>/dev/tcp/127.0.0.1/${port} && head -c 16 <&3) 2>/dev/null || echo refused`;
    const out: Record<string, string> = {};
    const worker = await liveRun(live, {
      steps: [
        call("c1", "bash", {
          command: [
            "cat /proc/sys/kernel/random/boot_id",
            `echo "probe:$(${probe(47001)})"`,
            "echo \"listed:$(pgrep -f '[p]3live-listener-c' || echo none)\"",
            `(setsid nohup ${listener("p3live-listener-w", 47002, "worker")} >/dev/null 2>&1 &)`,
            "sleep 1",
            `echo "self:$(${probe(47002)})"`,
            "echo \"own:$(pgrep -f '[p]3live-listener-w' >/dev/null && echo yes || echo no)\"",
          ].join("\n"),
        }),
        call("c2", "bash", { command: "sleep 5; echo listening" }, (request) => {
          out.worker = toolResult(request);
        }),
        ...finish("Probed localhost"),
      ],
    });
    const computer = await live.vm({});
    try {
      await computer.commands.run(listener("p3live-listener-c", 47001, "computer"), {
        background: true,
        timeoutMs: 0,
      });
      await sh(computer, "sleep 1");
      const computerBoot = await sh(computer, "cat /proc/sys/kernel/random/boot_id");
      const computerSelf = await sh(computer, probe(47001));
      const computerOwn = await sh(
        computer,
        "pgrep -f '[p]3live-listener-c' >/dev/null && echo yes || echo no",
      );
      let fromComputer = "";
      let listedInComputer = "";
      const runId = await worker.run.send("Probe localhost.");
      const running = worker.run.continueRun(runId);
      const grants = () =>
        worker
          .frames()
          .filter((frame) => frame.from === "controller" && frame.type === "tool.grant").length;
      // The worker's listener is up while its second command sleeps.
      for (let i = 0; i < 300 && grants() < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      if (grants() >= 2) {
        fromComputer = await sh(computer, probe(47002));
        listedInComputer = await sh(computer, "pgrep -f '[p]3live-listener-w' || echo none");
      }
      await running;
      await worker.completed(runId);
      const lines = Object.fromEntries(
        (out.worker ?? "")
          .split("\n")
          .filter((line) => line.includes(":"))
          .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)]),
      );
      const workerBoot = (out.worker ?? "").split("\n")[0]?.trim();
      const pass =
        (await worker.status(runId)) === "completed" &&
        computerSelf === "computer" &&
        lines.self === "worker" &&
        lines.probe === "refused" &&
        lines.listed === "none" &&
        lines.own === "yes" &&
        computerOwn === "yes" &&
        fromComputer === "refused" &&
        listedInComputer === "none" &&
        Boolean(workerBoot) &&
        workerBoot !== computerBoot;
      return {
        pass,
        observed: {
          computerListenerFromComputer: computerSelf,
          computerListenerFromWorker: lines.probe,
          workerListenerFromWorker: lines.self,
          workerListenerFromComputer: fromComputer,
          computerListenerListedInComputer: computerOwn,
          computerListenerListedInWorker: lines.listed === "none" ? "no" : "yes",
          workerListenerListedInWorker: lines.own,
          workerListenerListedInComputer: listedInComputer === "none" ? "no" : "yes",
          bootIdsDiffer: Boolean(workerBoot) && workerBoot !== computerBoot,
        },
      };
    } finally {
      await computer.kill().catch(() => false);
      await worker.close();
    }
  },
};
