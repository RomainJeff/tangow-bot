import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { CommandHandle, CommandResult, CommandStartOpts, Sandbox } from "@e2b/desktop";
import { CommandExitError } from "@e2b/desktop";
import type { E2BSandboxSdk } from "./e2b-sandbox.js";

const execFileAsync = promisify(execFile);

const WORKSPACE = "/home/user/rakazo-home";

/** An E2B computer as the SDK serves it: its workspace files by path, its metadata, its end. */
export function fakeE2BMachine(
  sandboxId: string,
  workspace: Record<string, string> = {},
  metadata: Record<string, string> = {},
) {
  const files = new Map(
    Object.entries(workspace).map(([file, text]) => [`${WORKSPACE}/${file}`, text]),
  );
  const machine = {
    files,
    killed: false,
    sandbox: {
      sandboxId,
      getInfo: async () => ({ metadata }),
      kill: async () => {
        machine.killed = true;
        return true;
      },
      setTimeout: async () => undefined,
      commands: { run: async () => ({ stdout: "", stderr: "", exitCode: 0 }) },
      files: {
        list: async (directory: string) => {
          const names = new Map<string, "file" | "dir">();
          for (const file of files.keys()) {
            if (!file.startsWith(`${directory}/`)) continue;
            const [name, ...rest] = file.slice(directory.length + 1).split("/");
            names.set(name!, rest.length ? "dir" : "file");
          }
          return [...names].map(([name, type]) => ({ name, type, size: 1, mode: 0o644 }));
        },
        read: async (file: string) => {
          const text = files.get(file);
          if (text === undefined) throw new Error(`${file} not found`);
          return new TextEncoder().encode(text);
        },
        write: async (written: Array<{ path: string; data: ArrayBuffer }>) => {
          for (const entry of written) files.set(entry.path, new TextDecoder().decode(entry.data));
        },
        makeDir: async () => true,
      },
    } as unknown as Sandbox,
  };
  return machine;
}

/** Real Linux shell/process execution behind the E2B SDK boundary, with no remote service. */
export async function dockerE2BMachine(image: string) {
  const name = `rakazo-e2b-browser-${randomUUID()}`;
  const docker = async (...args: string[]) => {
    try {
      const result = await execFileAsync("docker", args, {
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      if (
        error instanceof Error &&
        "stdout" in error &&
        "stderr" in error &&
        "code" in error &&
        typeof error.code === "number"
      )
        return { exitCode: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
      throw error;
    }
  };
  const started = await docker(
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--user",
    "0:0",
    "--entrypoint",
    "bash",
    image,
    "-eu",
    "-c",
    "mkdir -p /home/user/rakazo-home; chown -R 1000:1000 /home/user; exec sleep infinity",
  );
  if (started.exitCode) throw new Error(started.stderr);
  const exec = (command: string) =>
    docker("exec", "-u", "1000:1000", name, "bash", "-eu", "-c", command);
  const machine = fakeE2BMachine("machine");
  const processes: Array<ReturnType<typeof spawn>> = [];
  const pending: Promise<unknown>[] = [];
  let beforePermit: (() => Promise<void>) | undefined;
  let lastPid = 0;
  machine.sandbox.commands.run = (async (command: string, options?: CommandStartOpts) => {
    if (!options?.background) {
      const result = await exec(command);
      if (result.exitCode) throw new CommandExitError(result);
      return result;
    }
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        "-u",
        "1000:1000",
        name,
        "bash",
        "-c",
        `printf 'SDK_PID=%s\\n' "$BASHPID"; ${command}`,
      ],
      { stdio: "pipe" },
    );
    processes.push(child);
    let stdout = "";
    let stderr = "";
    let header = "";
    let pid = 0;
    let ready!: () => void;
    const acquired = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let fail!: (error: unknown) => void;
    const result = new Promise<CommandResult>((resolve, reject) => {
      fail = reject;
      child.on("error", reject);
      child.on("close", (code) => {
        if (!pid) ready();
        const value = { exitCode: code ?? 1, stdout, stderr };
        if (value.exitCode) reject(new CommandExitError(value));
        else resolve(value);
      });
    });
    pending.push(result.catch(() => undefined));
    const consume = (chunk: Buffer, output: "stdout" | "stderr") => {
      let text = chunk.toString();
      if (output === "stdout" && !pid) {
        header += text;
        const newline = header.indexOf("\n");
        if (newline < 0) return;
        pid = Number(header.slice(8, newline));
        lastPid = pid;
        text = header.slice(newline + 1);
        ready();
      }
      try {
        if (output === "stdout") {
          stdout += text;
          options.onStdout?.(text);
        } else {
          stderr += text;
          options.onStderr?.(text);
        }
      } catch (error) {
        fail(error);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));
    const aborted = () => fail(options.signal?.reason);
    options.signal?.addEventListener("abort", aborted, { once: true });
    await acquired;
    if (!pid) return result;
    return {
      pid,
      wait: () => result,
      sendStdin: async (input: string) => {
        await beforePermit?.();
        child.stdin.write(input);
      },
      closeStdin: async () => {
        child.stdin.end();
      },
      kill: () => machine.sandbox.commands.kill(pid),
      disconnect: async () => {
        options.signal?.removeEventListener("abort", aborted);
      },
    } as unknown as CommandHandle;
  }) as typeof machine.sandbox.commands.run;
  machine.sandbox.commands.kill = async (pid: number) =>
    (await exec(`kill -KILL ${pid}`)).exitCode === 0;
  return {
    machine,
    exec,
    sdk: { connect: async () => machine.sandbox } as unknown as E2BSandboxSdk,
    get pid() {
      return lastPid;
    },
    setBeforePermit(callback: () => Promise<void>) {
      beforePermit = callback;
    },
    async close() {
      await docker("rm", "-f", name);
      await Promise.all(pending);
      for (const child of processes) child.kill();
    },
  };
}
