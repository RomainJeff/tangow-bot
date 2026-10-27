import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { DockerSandboxProvider } from "@rakazo/adapters";
import { TRAVEL_SITE_PORT, TRAVEL_SITE_URL, travelSiteFiles } from "./site.js";

const ROOT = "/tmp/travel-site";

/** Writes the site outside the bot's volumes, so the bot reaches it only through the browser. */
function serveCommand(): string {
  const writes = [...travelSiteFiles()].map(
    ([file, html]) =>
      `mkdir -p "$(dirname ${ROOT}/${file})" && printf %s ${Buffer.from(html).toString("base64")} | base64 -d > ${ROOT}/${file}`,
  );
  const up = `curl -fsS -o /dev/null ${TRAVEL_SITE_URL}`;
  return [
    "set -e",
    `if ${up}; then exit 0; fi`,
    ...writes,
    `setsid -f python3 -m http.server ${TRAVEL_SITE_PORT} --bind 127.0.0.1 --directory ${ROOT} >/dev/null 2>&1 </dev/null`,
    `for i in $(seq 50); do if ${up}; then exit 0; fi; sleep 0.1; done`,
    "exit 1",
  ].join("\n");
}

/** A Docker computer that serves the travel site from the moment it is up. */
export class TravelSiteComputer extends DockerSandboxProvider {
  private readonly prepared = new Map<string, { computer: ComputerRef; spaceId: string }>();

  override async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    await super.prepare(computer, context);
    this.prepared.set(computer.id, { computer, spaceId: context.spaceId });
    let output = "";
    for await (const event of this.execute(
      computer,
      { argv: ["bash", "-c", serveCommand()], timeoutMs: 60_000 },
      context,
    )) {
      if (event.type === "exit" && event.code !== 0)
        throw new Error(`The travel site did not start: ${output.slice(-300)}`);
      if (event.type !== "exit") output += event.data;
    }
  }

  /** Removes every computer this provider prepared, so no trial inherits one. */
  async destroyPrepared(): Promise<void> {
    for (const [id, { computer, spaceId }] of this.prepared) {
      await this.destroy(computer, {
        operationId: "bench.destroy",
        traceId: "bench.destroy",
        spaceId,
        userId: "bench",
        signal: AbortSignal.timeout(60_000),
      });
      this.prepared.delete(id);
    }
  }
}
