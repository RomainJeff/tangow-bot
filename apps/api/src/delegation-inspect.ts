import type { JobPublisher } from "@rakazo/adapter-kit";
import { createDelegatedTasks, WorkNotAuthorizedError, WorkNotFoundError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import type { Context, Hono } from "hono";

/**
 * Minimal read surface for the delegation task tree. Follows the same
 * mount(app, deps, authenticate) shape as mountVoiceHttpRoutes (voice.ts) rather than the
 * orpc contract in packages/contracts/src/rpc.ts.
 */
export function mountDelegationHttpRoutes(
  app: Hono,
  deps: { prisma: PrismaClient; jobs: JobPublisher },
  authenticate: (c: Context) => Promise<Actor | null>,
) {
  app.get("/api/delegation/:workId/inspect", async (c) => {
    const actor = await authenticate(c);
    if (!actor) return c.json({ error: "Unauthorized" }, 401);
    const botId = c.req.header("x-rakazo-bot-id");
    if (!botId) return c.json({ error: "x-rakazo-bot-id header is required." }, 400);
    const workId = c.req.param("workId");
    const delegatedTasks = createDelegatedTasks({ prisma: deps.prisma, jobs: deps.jobs });
    try {
      const page = await delegatedTasks.inspect(workId, {
        userId: actor.userId,
        spaceId: actor.spaceId,
        botId,
        rights: {},
      });
      c.header("cache-control", "no-store");
      return c.json(page);
    } catch (error) {
      if (error instanceof WorkNotFoundError) return c.json({ error: error.message }, 404);
      if (error instanceof WorkNotAuthorizedError) return c.json({ error: error.message }, 403);
      throw error;
    }
  });
}
