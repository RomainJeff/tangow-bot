import type { Socket } from "node:net";
import { loadRootEnv } from "@tangow/core/node/load-root-env";

loadRootEnv();

import { serve } from "@hono/node-server";
import { assertE2BHomesOnVolumes, E2BHomesNotMigrated } from "@tangow/adapters";
import { createDb, moveLegacyMessages, RoundRefused } from "@tangow/db";
import { SERVICE_NAMES } from "@tangow/logging";
import { createRootLogger } from "@tangow/logging/axiom";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const logger = createRootLogger(SERVICE_NAMES.api);

try {
  const env = loadEnv();
  // A compose file from before the migrate service still upgrades: the API moves the messages
  // itself before it serves any thread.
  const legacy = createDb(env.databaseUrl, { poolMax: 1 });
  try {
    await moveLegacyMessages(legacy.prisma, { log: (line) => logger.info(line) });
    // Only an E2B deployment runs E2B computers: leftover rows must not block a Docker install.
    if (env.sandboxProvider === "e2b") await assertE2BHomesOnVolumes(legacy.prisma);
  } finally {
    await legacy.prisma.$disconnect();
    await legacy.pool.end();
  }
  const { app, stop } = await createApp({ ...env, logger });
  const server = serve({ fetch: app.fetch, port: env.port, hostname: env.apiHost }, () => {
    logger.info("api listening", { "http.host": env.apiHost, "http.port": env.port });
  });

  // Long-lived connections (threads.subscribe SSE streams) never end on their
  // own, so server.close() alone waits forever for them. Track sockets and
  // force-close any still open after a short grace period for in-flight
  // requests, or every restart/shutdown hangs until something force-kills it.
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    const grace = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 2_000);
    await closed;
    clearTimeout(grace);
    await stop();
    await logger.flush({ timeoutMs: 2_000 });
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
} catch (error) {
  if (error instanceof RoundRefused || error instanceof E2BHomesNotMigrated) {
    process.stderr.write(`${error.message}\n`);
  }
  logger.error("api startup failed", error);
  await logger.flush({ timeoutMs: 2_000 });
  process.exit(1);
}
