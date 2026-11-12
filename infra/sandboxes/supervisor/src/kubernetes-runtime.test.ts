import { chmodSync, mkdirSync, rmSync } from "node:fs";
import type { Readable } from "node:stream";
import type { V1Pod, V1Status } from "@kubernetes/client-node";
import { ApiException } from "@kubernetes/client-node";
import { resolveSupervisorToken } from "@tangow/core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  process.env.DATA_DIR = `${tmp}/tangow-kubernetes-runtime-${process.pid}-${Date.now()}`;
  delete process.env.SANDBOX_MAX_COMPUTERS_PER_SPACE;
});

import { resolveSupervisorBackend } from "./computer-spec.js";
import { createSupervisor } from "./index.js";
import type { KubernetesClient } from "./kubernetes-runtime.js";
import {
  computerPod,
  createKubernetesComputerRuntime,
  execInEnvelope,
} from "./kubernetes-runtime.js";

const dataDir = process.env.DATA_DIR!;
const token = resolveSupervisorToken(process.env);
const owner = { botId: "bot1", spaceId: "space1" };
const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  "x-tangow-bot-id": owner.botId,
  "x-tangow-space-id": owner.spaceId,
};

interface ExecCall {
  pod: string;
  command: string[];
  stdin: Buffer;
}

/** The few pod calls the backend makes, kept in memory, plus exec and the control probe. */
function fakeCluster() {
  const pods = new Map<string, V1Pod>();
  const state = {
    quotaExceeded: false,
    /** What a pending pod becomes on its next read. */
    boot: "running" as "running" | "image-missing",
    nextIp: 1,
    deletes: [] as Array<{ name: string; grace: number | undefined }>,
    execs: [] as ExecCall[],
    exitCode: 0,
  };
  const notFound = (name: string) =>
    new ApiException(404, "Not Found", { message: `pods "${name}" not found` }, {});
  const client: KubernetesClient = {
    pods: {
      createNamespacedPod: async ({ body }) => {
        const name = body.metadata!.name!;
        if (state.quotaExceeded) {
          throw new ApiException(
            403,
            "Forbidden",
            { message: `pods "${name}" is forbidden: exceeded quota: sandboxes` },
            {},
          );
        }
        if (pods.has(name)) throw new ApiException(409, "Conflict", {}, {});
        pods.set(name, { ...structuredClone(body), status: { phase: "Pending" } });
        return structuredClone(pods.get(name)!);
      },
      readNamespacedPod: async ({ name }) => {
        const pod = pods.get(name);
        if (!pod) throw notFound(name);
        // A deleted pod is read once more while it terminates, then it is gone.
        if (pod.metadata!.deletionTimestamp) pods.delete(name);
        else if (pod.status!.phase === "Pending" && state.boot === "running") {
          pod.status = { phase: "Running", podIP: `10.42.0.${state.nextIp++}` };
        } else if (pod.status!.phase === "Pending") {
          pod.status = {
            phase: "Pending",
            containerStatuses: [
              {
                name: "computer",
                image: pod.spec!.containers[0]!.image!,
                imageID: "",
                ready: false,
                restartCount: 0,
                state: {
                  waiting: { reason: "ErrImageNeverPull", message: "image is not present" },
                },
              },
            ],
          };
        }
        return structuredClone(pod);
      },
      deleteNamespacedPod: async ({ name, gracePeriodSeconds }) => {
        const pod = pods.get(name);
        if (!pod) throw notFound(name);
        state.deletes.push({ name, grace: gracePeriodSeconds });
        pod.metadata!.deletionTimestamp = new Date();
        return structuredClone(pod);
      },
    },
    podExec: {
      exec: async (
        _namespace,
        pod,
        _container,
        command,
        stdout,
        _stderr,
        stdin,
        _tty,
        onStatus,
      ) => {
        if (!pods.has(pod)) throw new Error(`pods "${pod}" not found`);
        const call: ExecCall = { pod, command: command as string[], stdin: Buffer.alloc(0) };
        state.execs.push(call);
        const socket = new EventTarget() as EventTarget & { close(): void };
        socket.close = () => socket.dispatchEvent(new Event("close"));
        const finish = () => {
          stdout?.end("done");
          const status: V1Status =
            state.exitCode === 0
              ? { status: "Success" }
              : {
                  status: "Failure",
                  reason: "NonZeroExitCode",
                  details: { causes: [{ reason: "ExitCode", message: String(state.exitCode) }] },
                };
          onStatus?.(status);
          socket.close();
        };
        if (stdin) {
          (stdin as Readable).on("data", (chunk: Buffer) => {
            call.stdin = Buffer.concat([call.stdin, chunk]);
          });
          (stdin as Readable).on("end", finish);
        } else setImmediate(finish);
        return socket;
      },
    },
    probeControl: async () => true,
  };
  return { client, pods, state };
}

function kubernetes(cluster = fakeCluster()) {
  const runtime = createKubernetesComputerRuntime({
    namespace: "sandboxes",
    dataClaim: "data",
    dataDir,
    client: cluster.client,
  });
  const { app } = createSupervisor(runtime);
  const provision = () =>
    settle(
      app.request("/computers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...owner,
          userId: "user1",
          homePath: `${dataDir}/homes/${owner.botId}`,
        }),
      }),
    );
  return { ...cluster, runtime, app, provision };
}

/** Lets the backend's waits run on fake time. */
async function settle<T>(request: T | Promise<T>) {
  const pending = Promise.resolve(request);
  let done = false;
  void pending.finally(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(500);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(`${dataDir}/homes/${owner.botId}`, { recursive: true });
  // The home is checked for the computer's user, 1000, which is not the test runner.
  chmodSync(`${dataDir}/homes/${owner.botId}`, 0o777);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("computer pod", () => {
  it("is hardened, mounts the data claim by subPath, and declares fixed requests", () => {
    expect(
      computerPod({
        name: "tangow-bot-bot1",
        image: "tangow/computer@sha256:abc",
        owner,
        controlToken: "token-1",
        dataClaim: "data",
        mounts: [
          { mountPath: "/home/tangow", subPath: "homes/bot1", readOnly: false },
          { mountPath: "/skills/user", subPath: "skills/user/space1/user1", readOnly: true },
          { mountPath: "/managed-skills", subPath: "managed-skills", readOnly: true },
        ],
        limits: { memory: "8589934592", cpu: "4000m" },
        workingDir: "/home/tangow",
        annotations: {},
      }),
    ).toEqual({
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "tangow-bot-bot1",
        labels: { "tangow.managed": "true", "tangow.botId": "bot1", "tangow.spaceId": "space1" },
        annotations: {},
      },
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 10,
        securityContext: {
          runAsUser: 1000,
          runAsGroup: 1000,
          runAsNonRoot: true,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "computer",
            image: "tangow/computer@sha256:abc",
            imagePullPolicy: "Never",
            tty: true,
            workingDir: "/home/tangow",
            env: [
              { name: "DISPLAY", value: ":1" },
              { name: "HOME", value: "/home/tangow" },
              {
                name: "PATH",
                value:
                  "/home/tangow/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
              },
              { name: "NPM_CONFIG_PREFIX", value: "/home/tangow/.local" },
              { name: "PIP_USER", value: "1" },
              { name: "TANGOW_COMPUTER_CONTROL_TOKEN", value: "token-1" },
            ],
            resources: {
              requests: { memory: "2Gi", cpu: "1" },
              limits: { memory: "8589934592", cpu: "4000m" },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            volumeMounts: [
              { name: "data", mountPath: "/home/tangow", subPath: "homes/bot1", readOnly: false },
              {
                name: "data",
                mountPath: "/skills/user",
                subPath: "skills/user/space1/user1",
                readOnly: true,
              },
              {
                name: "data",
                mountPath: "/managed-skills",
                subPath: "managed-skills",
                readOnly: true,
              },
              { name: "shm", mountPath: "/dev/shm" },
            ],
          },
        ],
        volumes: [
          { name: "data", persistentVolumeClaim: { claimName: "data" } },
          { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
        ],
      },
    });
  });

  it("runs commands through one fixed envelope, with every value in argv", () => {
    expect(execInEnvelope("/home/tangow/a dir", ["A=1"], ["echo", "$HOME"])).toEqual([
      "sh",
      "-c",
      'cd "$1" && shift && exec env "$@"',
      "sh",
      "/home/tangow/a dir",
      "A=1",
      "echo",
      "$HOME",
    ]);
  });
});

describe("Kubernetes computers", () => {
  it("creates a named pod, deletes it on stop, and creates it again on the new IP", async () => {
    const { provision, app, pods, state, runtime } = kubernetes();

    const created = await provision();
    expect(await created.json()).toMatchObject({ id: "tangow-bot-bot1", resumed: false });
    const first = await runtime.getComputer({ id: "tangow-bot-bot1", owner, screenPort: "6080" });
    expect(first.screen).toEqual({ host: "10.42.0.1", port: "6080" });

    const stopped = await settle(
      app.request("/computers/tangow-bot-bot1/stop", { method: "POST", headers }),
    );
    expect(stopped.status).toBe(200);
    expect(state.deletes).toEqual([{ name: "tangow-bot-bot1", grace: 10 }]);
    expect(pods.has("tangow-bot-bot1")).toBe(false);

    const resumed = await provision();
    expect(await resumed.json()).toMatchObject({ id: "tangow-bot-bot1", resumed: false });
    const second = await runtime.getComputer({ id: "tangow-bot-bot1", owner, screenPort: "6080" });
    expect(second.screen).toEqual({ host: "10.42.0.2", port: "6080" });
    expect(second.control?.url).toBe("http://10.42.0.2:7070/v1/desktop");
  });

  it("removes a computer without grace and only answers once the pod is gone", async () => {
    const { provision, app, pods, state } = kubernetes();
    await provision();

    const removed = await settle(
      app.request("/computers/tangow-bot-bot1", { method: "DELETE", headers }),
    );

    expect(removed.status).toBe(200);
    expect(state.deletes).toEqual([{ name: "tangow-bot-bot1", grace: 0 }]);
    expect(pods.size).toBe(0);
  });

  it("returns the quota refusal from the create", async () => {
    const cluster = fakeCluster();
    cluster.state.quotaExceeded = true;
    const { provision } = kubernetes(cluster);

    const response = await provision();

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain("exceeded quota");
  });

  it("gives up at the deadline with the pod's last reason and deletes the pod", async () => {
    const cluster = fakeCluster();
    cluster.state.boot = "image-missing";
    const { provision, pods } = kubernetes(cluster);

    const response = await provision();

    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toContain("ErrImageNeverPull");
    expect(cluster.state.deletes).toEqual([{ name: "tangow-bot-bot1", grace: 0 }]);
    expect([...pods.values()].every((pod) => pod.metadata?.deletionTimestamp)).toBe(true);
  });

  it("writes a file through the command's stdin and reports a command's exit code", async () => {
    const { provision, app, state } = kubernetes();
    await provision();

    const written = await app.request("/computers/tangow-bot-bot1/files", {
      method: "POST",
      headers,
      body: JSON.stringify({ path: "notes.txt", content: Buffer.from("hello").toString("base64") }),
    });
    expect(written.status).toBe(200);
    expect(state.execs.at(-1)!.stdin.toString()).toBe("hello");

    state.exitCode = 3;
    const ran = await app.request("/computers/tangow-bot-bot1/exec", {
      method: "POST",
      headers,
      body: JSON.stringify({ argv: ["false"] }),
    });
    expect(await ran.json()).toMatchObject({ code: 3 });
  });

  it("refuses to start with a per-space computer cap", () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_SPACE", "2");
    try {
      expect(() => kubernetes()).toThrow(/SANDBOX_MAX_COMPUTERS_PER_SPACE/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("supervisor backend", () => {
  it("defaults to docker, selects kubernetes, and refuses anything else", () => {
    expect(resolveSupervisorBackend(undefined)).toBe("docker");
    expect(resolveSupervisorBackend("kubernetes")).toBe("kubernetes");
    expect(() => resolveSupervisorBackend("k8s")).toThrow(/SUPERVISOR_BACKEND/);
  });
});
