import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPERVISOR = fileURLToPath(
  new URL("../../../infra/sandboxes/supervisor/src/index.ts", import.meta.url),
);

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A real supervisor on this machine, on its own `DATA_DIR` and token, until `stop`. */
export async function startDockerSupervisor(options: {
  dataDir: string;
  token: string;
  env?: Record<string, string>;
}): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", SUPERVISOR], {
    cwd: path.dirname(path.dirname(SUPERVISOR)),
    stdio: ["ignore", "ignore", process.env.RAKAZO_WORKER_DEBUG ? "inherit" : "ignore"],
    env: {
      ...process.env,
      ...options.env,
      DATA_DIR: options.dataDir,
      SANDBOX_SUPERVISOR_TOKEN: options.token,
      SUPERVISOR_PORT: String(port),
      SUPERVISOR_HOST: "127.0.0.1",
    },
  });
  const stop = () => {
    child.kill("SIGTERM");
  };
  for (let tries = 0; ; tries++) {
    const ok = await fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return { url, stop };
    if (tries > 100 || child.exitCode !== null) {
      stop();
      throw new Error("The supervisor did not start");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
