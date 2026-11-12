import { randomUUID } from "node:crypto";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { V1Pod, V1Status } from "@kubernetes/client-node";
import { ApiException, CoreV1Api, Exec, KubeConfig } from "@kubernetes/client-node";
import { SANDBOX_SKILL_MOUNTS } from "@tangow/core";
import type {
  Computer,
  ComputerOwner,
  ComputerRuntime,
  ComputerSpec,
  ExecOptions,
  ExecResult,
} from "./computer-runtime.js";
import { ComputerIdentityError, ComputerNotFoundError } from "./computer-runtime.js";
import { SCREEN_READY_TIMEOUT_MS } from "./computer-session.js";
import {
  COMPUTER_CONTROL_PORT,
  COMPUTER_GID,
  COMPUTER_IMAGE,
  COMPUTER_UID,
  computerResourceLimits,
  computerVolumeHome,
  computerWorkspace,
  containerNameFor,
  resolveSpaceComputerLimit,
  volumeHomeLabels,
} from "./computer-spec.js";
import { assertComputerHomeWritable } from "./home-ownership.js";
import { hasComputerIdentity } from "./supervisor-logic.js";

const CONTAINER = "computer";
/** Docker's stop timeout, so a stopping computer gets the same time to save its browsers. */
const STOP_GRACE_SECONDS = 10;
/** How long a deleted pod may take to disappear before its name can be used again. */
const DELETE_TIMEOUT_MS = 30_000;
const POLL_MS = 500;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/** `pods/exec` has no cwd or env: one fixed script takes both, and the command, as argv. */
export const EXEC_ENVELOPE = 'cd "$1" && shift && exec env "$@"';

export function execInEnvelope(cwd: string, env: string[], argv: string[]) {
  return ["sh", "-c", EXEC_ENVELOPE, "sh", cwd, ...env, ...argv];
}

export interface PodMount {
  mountPath: string;
  /** Under `DATA_DIR`, which the data claim holds. */
  subPath: string;
  readOnly: boolean;
}

/** A computer pod. The UID, the hardening and the requests are fixed; the rest comes from its spec. */
export function computerPod(input: {
  name: string;
  image: string;
  owner: ComputerOwner;
  controlToken: string;
  dataClaim: string;
  mounts: PodMount[];
  limits: Record<string, string>;
  workingDir: string;
  annotations: Record<string, string>;
}): V1Pod {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: input.name,
      labels: {
        "tangow.managed": "true",
        "tangow.botId": input.owner.botId,
        "tangow.spaceId": input.owner.spaceId,
      },
      annotations: input.annotations,
    },
    spec: {
      automountServiceAccountToken: false,
      // Services in the namespace would otherwise inject `<NAME>_PORT` variables into the computer,
      // and one of them has already broken a real computer by shadowing a variable it reads.
      enableServiceLinks: false,
      restartPolicy: "Never",
      terminationGracePeriodSeconds: STOP_GRACE_SECONDS,
      securityContext: {
        runAsUser: COMPUTER_UID,
        runAsGroup: COMPUTER_GID,
        runAsNonRoot: true,
        seccompProfile: { type: "RuntimeDefault" },
      },
      containers: [
        {
          name: CONTAINER,
          image: input.image,
          // Images are imported on the node by digest; the backend never pulls or builds one.
          imagePullPolicy: "Never",
          tty: true,
          workingDir: input.workingDir,
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
            { name: "TANGOW_COMPUTER_CONTROL_TOKEN", value: input.controlToken },
          ],
          resources: {
            // Without explicit requests they default to the limits, which the namespace quota
            // refuses at create.
            requests: { memory: "2Gi", cpu: "1" },
            limits: input.limits,
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] },
          },
          volumeMounts: [
            ...input.mounts.map((mount) => ({ name: "data", ...mount })),
            { name: "shm", mountPath: "/dev/shm" },
          ],
        },
      ],
      volumes: [
        { name: "data", persistentVolumeClaim: { claimName: input.dataClaim } },
        { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
      ],
    },
  };
}

/** What the backend reads from the cluster, so a fake can stand in for it. */
export interface KubernetesClient {
  pods: Pick<CoreV1Api, "createNamespacedPod" | "readNamespacedPod" | "deleteNamespacedPod">;
  podExec: {
    exec(...args: Parameters<Exec["exec"]>): Promise<{
      close(): void;
      addEventListener(type: "close", listener: () => void): void;
    }>;
  };
  /** True once the computer's control service answers its token. */
  probeControl(control: { url: string; token: string }): Promise<boolean>;
}

function inClusterClient(): KubernetesClient {
  const config = new KubeConfig();
  config.loadFromCluster();
  return {
    pods: config.makeApiClient(CoreV1Api),
    podExec: new Exec(config),
    probeControl: async ({ url, token }) => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ steps: [], observe: false }),
          signal: AbortSignal.timeout(1_500),
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

function isNotFound(error: unknown) {
  return error instanceof ApiException && error.code === 404;
}

function apiMessage(error: unknown) {
  if (!(error instanceof ApiException)) return error instanceof Error ? error.message : `${error}`;
  const body = error.body as { message?: string } | string | undefined;
  return (typeof body === "object" ? body?.message : body) || `HTTP ${error.code}`;
}

/** Why a pod is not running yet: its container's waiting reason, or why it is not scheduled. */
function podReason(pod: V1Pod) {
  const state = pod.status?.containerStatuses?.[0]?.state;
  const container = state?.waiting ?? state?.terminated;
  const unscheduled = pod.status?.conditions?.find(
    (condition) => condition.type === "PodScheduled" && condition.status === "False",
  );
  const reason = container ?? unscheduled;
  if (!reason?.reason) return pod.status?.phase;
  return reason.message ? `${reason.reason}: ${reason.message}` : reason.reason;
}

function controlOf(pod: V1Pod) {
  const token = pod.spec?.containers[0]?.env?.find(
    (variable) => variable.name === "TANGOW_COMPUTER_CONTROL_TOKEN",
  )?.value;
  const address = pod.status?.podIP;
  if (!token || !address) return undefined;
  return { url: `http://${address}:${COMPUTER_CONTROL_PORT}/v1/desktop`, token };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The Kubernetes backend: a `tangow-bot-<id>` pod per computer, deleted on stop and created again
 * on resume, so a computer is running exactly while its pod is. Workers come in a later slice.
 */
export function createKubernetesComputerRuntime(options: {
  namespace: string;
  dataClaim: string;
  dataDir: string;
  client?: KubernetesClient;
}): ComputerRuntime {
  const { namespace, dataClaim, dataDir } = options;
  // The namespace's ResourceQuota bounds computers; a per-space count would need every pod listed.
  if (resolveSpaceComputerLimit() > 0) {
    throw new Error(
      "SANDBOX_MAX_COMPUTERS_PER_SPACE is not supported with SUPERVISOR_BACKEND=kubernetes: leave it at 0",
    );
  }
  const { pods, podExec, probeControl } = options.client ?? inClusterClient();

  function podName(botId: string) {
    const name = containerNameFor(botId);
    if (!DNS_LABEL.test(name)) throw new Error(`computer pod name ${name} is not a DNS label`);
    return name;
  }

  function podMounts(spec: ComputerSpec): PodMount[] {
    const under = (absolute: string) => path.relative(dataDir, absolute);
    const skills = spec.skillsBotId
      ? path.join("skills", "bot", spec.spaceId, spec.skillsBotId)
      : path.join("skills", "user", spec.spaceId, spec.userId);
    const volumes = spec.volumeHome
      ? computerVolumeHome(spec.volumeHome, dataDir, undefined).mounts.map((mount) => ({
          mountPath: mount.target,
          subPath: "bind" in mount.source ? under(mount.source.bind) : mount.source.subpath,
          readOnly: false,
        }))
      : [];
    return [
      { mountPath: "/home/tangow", subPath: under(spec.homePath), readOnly: false },
      { mountPath: SANDBOX_SKILL_MOUNTS.user, subPath: skills, readOnly: true },
      { mountPath: SANDBOX_SKILL_MOUNTS.managed, subPath: "managed-skills", readOnly: true },
      ...volumes,
    ];
  }

  async function readPod(name: string) {
    try {
      return await pods.readNamespacedPod({ name, namespace });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  /** Deletes the pod and waits until its name is free, so a resume cannot hit a 409. */
  async function deletePod(name: string, gracePeriodSeconds: number, missing: () => void) {
    try {
      await pods.deleteNamespacedPod({ name, namespace, gracePeriodSeconds });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      missing();
    }
    const deadline = Date.now() + DELETE_TIMEOUT_MS;
    while (await readPod(name)) {
      if (Date.now() >= deadline) throw new Error(`computer pod ${name} is still terminating`);
      await delay(POLL_MS);
    }
  }

  function toComputer(pod: V1Pod): Computer {
    return {
      id: pod.metadata!.name!,
      running: pod.status?.phase === "Running" && !pod.metadata?.deletionTimestamp,
      image: pod.spec!.containers[0]!.image!,
      releaseRef: pod.spec!.containers[0]!.image!,
      matchesSpec: true,
      workspace: computerWorkspace(pod.metadata?.annotations),
      control: controlOf(pod),
    };
  }

  /** Running, then answering on its control port, within the readiness delay. */
  async function waitUntilReady(name: string) {
    const deadline = Date.now() + SCREEN_READY_TIMEOUT_MS;
    let reason: string | undefined;
    for (;;) {
      const pod = await readPod(name);
      if (!pod) throw new Error(`computer pod ${name} disappeared while starting`);
      const phase = pod.status?.phase;
      reason = podReason(pod) ?? reason;
      if (phase === "Failed" || phase === "Succeeded") {
        throw new Error(`computer pod ${name} exited while starting (${reason})`);
      }
      const control = controlOf(pod);
      if (phase === "Running" && control) {
        if (await probeControl(control)) return;
        reason = "the control service did not answer";
      }
      if (Date.now() >= deadline) {
        throw new Error(`computer pod ${name} did not become ready in time (${reason})`);
      }
      await delay(POLL_MS);
    }
  }

  async function getComputer(query: {
    id: string;
    owner: ComputerOwner;
    screenPort?: string;
  }): Promise<Computer>;
  async function getComputer(query: { spec: ComputerSpec }): Promise<Computer | undefined>;
  async function getComputer(
    query: { id: string; owner: ComputerOwner; screenPort?: string } | { spec: ComputerSpec },
  ): Promise<Computer | undefined> {
    if ("spec" in query) {
      const pod = await readPod(podName(query.spec.botId));
      if (!pod || !hasComputerIdentity(pod.metadata?.labels, query.spec.botId, query.spec.spaceId))
        return undefined;
      const mounted = (pod.spec?.containers[0]?.volumeMounts ?? [])
        .filter((mount) => mount.name === "data")
        .map((mount) => ({
          mountPath: mount.mountPath,
          subPath: mount.subPath ?? "",
          readOnly: Boolean(mount.readOnly),
        }));
      return {
        ...toComputer(pod),
        matchesSpec: JSON.stringify(mounted) === JSON.stringify(podMounts(query.spec)),
      };
    }
    const pod = await readPod(query.id);
    if (!pod) throw new ComputerNotFoundError(`computer ${query.id} not found`);
    const labels = pod.metadata?.labels;
    if (
      labels?.["tangow.managed"] !== "true" ||
      !hasComputerIdentity(labels, query.owner.botId, query.owner.spaceId)
    )
      throw new ComputerIdentityError("computer identity mismatch");
    const computer = toComputer(pod);
    // Read on every call: a resumed computer is a new pod with a new address.
    if (query.screenPort && pod.status?.podIP) {
      computer.screen = { host: pod.status.podIP, port: query.screenPort };
    }
    return computer;
  }

  async function ensureComputer(
    spec: ComputerSpec,
    existing?: Pick<Computer, "id" | "running" | "releaseRef"> & { replace: boolean },
  ) {
    if (existing?.running && !existing.replace) {
      return { id: existing.id, releaseRef: existing.releaseRef, resumed: true };
    }
    const name = podName(spec.botId);
    // The API creates the home; a missing one is an error, never created here.
    await assertComputerHomeWritable(spec.homePath, COMPUTER_UID, COMPUTER_GID);
    const volumeHome = spec.volumeHome
      ? computerVolumeHome(spec.volumeHome, dataDir, undefined)
      : undefined;
    if (existing) await deletePod(existing.id, 0, () => undefined);
    const { Memory, NanoCpus } = computerResourceLimits();
    const body = computerPod({
      name,
      image: COMPUTER_IMAGE,
      owner: spec,
      controlToken: randomUUID(),
      dataClaim,
      mounts: podMounts(spec),
      limits: {
        ...(Memory ? { memory: String(Memory) } : {}),
        ...(NanoCpus ? { cpu: `${NanoCpus / 1e6}m` } : {}),
      },
      workingDir: volumeHome?.root ?? "/home/tangow",
      annotations: volumeHomeLabels(volumeHome),
    });
    try {
      await pods.createNamespacedPod({ namespace, body });
    } catch (error) {
      // The namespace quota refuses at admission: its message names what is exceeded.
      throw new Error(`computer pod ${name} was refused: ${apiMessage(error)}`);
    }
    try {
      await waitUntilReady(name);
    } catch (error) {
      await pods
        .deleteNamespacedPod({ name, namespace, gracePeriodSeconds: 0 })
        .catch(() => undefined);
      throw error;
    }
    return { id: name, releaseRef: COMPUTER_IMAGE, resumed: false };
  }

  async function exec(id: string, argv: string[], options: ExecOptions): Promise<ExecResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const collect = (chunks: Buffer[]) =>
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });
    // v5.channel.k8s.io carries the end of stdin, which the file write and the page helper need.
    const stdin = options.stdin !== undefined || signal ? new PassThrough() : null;
    let status: V1Status | undefined;
    const socket = await podExec.exec(
      namespace,
      id,
      CONTAINER,
      execInEnvelope(options.cwd, options.env, argv),
      collect(stdout),
      collect(stderr),
      stdin,
      false,
      (received) => {
        status = received;
      },
    );
    if (options.stdin !== undefined) stdin?.end(options.stdin);
    let onAbort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("close", () => resolve());
        onAbort = () => {
          // Settle first: closing the socket may report `close` at once.
          reject(signal?.reason ?? new Error("command cancelled"));
          // The client sends stdin's v5 close frame on `end`; the socket closes after it.
          if (stdin) {
            stdin.once("end", () => socket.close());
            stdin.end();
          } else socket.close();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    if (!status) throw new Error("computer command ended without a status");
    const exitCode = status.details?.causes?.find((cause) => cause.reason === "ExitCode")?.message;
    if (status.status !== "Success" && exitCode === undefined) {
      throw new Error(status.message || "computer command failed");
    }
    return {
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
      code: exitCode === undefined ? 0 : Number(exitCode),
    };
  }

  const workersNotImplemented = (): never => {
    throw new Error("workers are not implemented on the Kubernetes backend yet");
  };

  return {
    release: async () => COMPUTER_IMAGE,
    getComputer,
    ensureComputer,
    stopComputer: (id) =>
      deletePod(id, STOP_GRACE_SECONDS, () => {
        throw new ComputerNotFoundError(`computer ${id} not found`);
      }),
    removeComputer: (id) => deletePod(id, 0, () => undefined),
    exec,
    workers: {
      ensure: async () => workersNotImplemented(),
      destroy: async () => workersNotImplemented(),
      openGuest: async () => workersNotImplemented(),
    },
  };
}
