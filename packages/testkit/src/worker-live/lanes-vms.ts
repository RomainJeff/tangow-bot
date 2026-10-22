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
    call("r1", "read", { path: "from-computer.txt" }),
    call("r2", "read", { path: "/workspace/shared/from-computer.txt" }, (request) => {
      results.readPrivate = toolResult(request);
    }),
    call(
      "w1",
      "write",
      { path: "from-worker.txt", content: "draft by the worker\n" },
      (request) => {
        results.readShared = toolResult(request);
      },
    ),
    call(
      "e1",
      "edit",
      { path: "from-worker.txt", edits: [{ oldText: "draft", newText: "edited" }] },
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
    call(
      "mount-root",
      "bash",
      {
        command: `node -e 'const fs=require("fs"), cp=require("child_process"), root=process.cwd(); const target=cp.execFileSync("findmnt",["-rn","-T",root,"-o","TARGET"]).toString().trim(); let rejectionCode=null; try { fs.renameSync(root,root+".n13-replaced"); fs.renameSync(root+".n13-replaced",root); } catch(e) { rejectionCode=e.code; } console.log(JSON.stringify({mountRoot:target===root,replacementRejected:["EBUSY","EACCES","EPERM"].includes(rejectionCode),rejectionCode}));'`,
      },
      (request) => {
        results.bash = toolResult(request);
      },
    ),
    ...finish("Exchanged files with the computer", (request) => {
      results.mountRoot = toolResult(request);
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
  const frames = worker.seen.map(({ at, from, frame }) => ({
    at,
    from,
    message: JSON.parse(Buffer.from(frame).toString()) as {
      payload?: { seq?: number; re?: number; body?: { type?: string; callId?: string } };
    },
  }));
  /** When the controller granted the guest tool call `callId`, matched by its request's seq. */
  const grantOf = (callId: string) => {
    const request = frames.find(
      ({ from, message }) =>
        from === "guest" &&
        message.payload?.body?.type === "tool.call" &&
        message.payload.body.callId === callId,
    );
    const seq = request?.message.payload?.seq;
    return frames.find(
      ({ from, message }) =>
        from === "controller" &&
        seq !== undefined &&
        message.payload?.re === seq &&
        message.payload.body?.type === "tool.grant",
    )?.at;
  };
  /** From the grant of the guest tool that wrote, `e1` for the private file and `b1` the shared. */
  const sinceGrant = (seenAt: number, callId: string) =>
    Math.round(seenAt - (grantOf(callId) ?? Number.NaN));
  const pass =
    (await worker.status(runId)) === "completed" &&
    results.readPrivate?.includes("written by the computer") === true &&
    results.readShared?.includes("shared by the computer") === true &&
    results.edit?.includes("Successfully replaced") === true &&
    results.grep?.includes("from-worker.txt:1: edited by the worker") === true &&
    results.grep?.includes("from-computer.txt:1: written by the computer") === true &&
    results.bash?.includes("written by the computer") === true &&
    results.mountRoot?.includes('"mountRoot":true') === true &&
    results.mountRoot?.includes('"replacementRejected":true') === true &&
    mine.out.startsWith("seen") &&
    shared.out.startsWith("seen");
  return {
    pass,
    observed: {
      guestToolResults: results,
      computerSawPrivateWrite: mine.out,
      computerSawSharedWrite: shared.out,
      privateVisibleWithinMsOfGrant: sinceGrant(mine.at, "e1"),
      sharedVisibleWithinMsOfGrant: sinceGrant(shared.at, "b1"),
      pollIntervalMs: POLL_INTERVAL_S * 1000,
      note: "Null grant timings mean the harness uses native tools without P2 grants. When present, visibility times run from the controller granting the guest tool that wrote, matched by its request's seq (edit e1 for the private file, bash b1 for the shared one), to the host seeing the computer's poller exit. They include the tool's own run and E2B's command stream, so they bound the cross-VM delay from above.",
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
      await worker.run.startComputer();
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
          desktopPreparation: live.config.prepareComputer
            ? "product E2BSandboxProvider.prepare"
            : "skipped for plain P3 fixture; not parity evidence",
        },
      };
    } finally {
      await worker.close();
    }
  },
};

/**
 * Below Linux's ephemeral range, which the VMs' own daemons draw from: rpc.statd once held lane c's
 * earlier 47001 in a worker.
 */
const COMPUTER_PORT = 7101;
const WORKER_PORT = 7102;

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
    // Bounded, so a port some daemon of the VM holds reads as silent instead of hanging the lane.
    const probe = (port: number) =>
      `r=$(timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port} && head -c 16 <&3' 2>/dev/null); c=$?; if [ $c -eq 124 ]; then echo silent; elif [ -n "$r" ]; then echo "$r"; else echo refused; fi`;
    const out: Record<string, string> = {};
    let markListenerReady = () => {};
    const listenerReady = new Promise<void>((resolve) => {
      markListenerReady = resolve;
    });
    const worker = await liveRun(live, {
      steps: [
        call("c1", "bash", {
          command: [
            "cat /proc/sys/kernel/random/boot_id",
            `echo "probe:$(${probe(COMPUTER_PORT)})"`,
            'echo "listed:$(pgrep -x n13-listen-c || echo none)"',
            `(setsid nohup ${listener("n13-listen-w", WORKER_PORT, "worker")} >/dev/null 2>&1 &)`,
            "sleep 1",
            `echo "self:$(${probe(WORKER_PORT)})"`,
            'echo "own:$(pgrep -x n13-listen-w >/dev/null && echo yes || echo no)"',
          ].join("\n"),
        }),
        call("c2", "bash", { command: "sleep 5; echo listening" }, (request) => {
          out.worker = toolResult(request);
          markListenerReady();
        }),
        ...finish("Probed localhost"),
      ],
    });
    const computer = await live.vm({});
    try {
      await computer.commands.run(listener("n13-listen-c", COMPUTER_PORT, "computer"), {
        background: true,
        timeoutMs: 0,
      });
      await sh(computer, "sleep 1");
      const computerBoot = await sh(computer, "cat /proc/sys/kernel/random/boot_id");
      const computerSelf = await sh(computer, probe(COMPUTER_PORT));
      const computerOwn = await sh(
        computer,
        "pgrep -x n13-listen-c >/dev/null && echo yes || echo no",
      );
      let fromComputer = "";
      let listedInComputer = "";
      const runId = await worker.run.send("Probe localhost.");
      const running = worker.run.continueRun(runId);
      await Promise.race([listenerReady, running]);
      if (out.worker) {
        fromComputer = await sh(computer, probe(WORKER_PORT));
        listedInComputer = await sh(computer, "pgrep -x n13-listen-w || echo none");
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
