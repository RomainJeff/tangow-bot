import { Sandbox, SandboxNotFoundError, Volume } from "e2b";
import type { VolumeImportSource } from "./docker-volume-import.js";
import { E2BVolumeFiles, e2bVolumeSandbox } from "./e2b-volume-files.js";

/** Opens existing volumes only; destroying a computer never deletes its volumes. */
export async function openE2BDockerSource(options: {
  apiKey: string;
  template: string;
  operationId: string;
}) {
  const connection = { apiKey: options.apiKey, requestTimeoutMs: 60_000 };
  async function destroy(ref: string) {
    await Sandbox.kill(ref, connection);
    try {
      await Sandbox.getInfo(ref, connection);
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return;
      throw error;
    }
    throw new Error("E2B sandbox still exists after teardown; refusing volume copy");
  }
  // A killed operator process can leave its reader VM holding a volume mount.
  const readers = Sandbox.list({
    ...connection,
    query: { metadata: { rakazo: "volume-files", rakazoMigration: options.operationId } },
  });
  while (readers.hasNext) {
    for (const reader of await readers.nextItems()) await destroy(reader.sandboxId);
  }
  const available = new Set((await Volume.list(connection)).map((volume) => volume.name));
  const files = new E2BVolumeFiles(
    e2bVolumeSandbox({
      template: options.template,
      connection,
      metadata: { rakazoMigration: options.operationId },
    }),
  );
  let currentVolume: string | null = null;
  async function selectVolume(ref: string) {
    if (currentVolume && currentVolume !== ref) await files.close();
    currentVolume = ref;
  }
  return {
    source: {
      async inspect(ref, context) {
        if (!available.has(ref))
          throw new Error("An E2B source volume is missing; refusing migration");
        await selectVolume(ref);
        return files.inspect(ref, context);
      },
      read: (ref, file, context) => files.read(ref, file, context),
    } satisfies VolumeImportSource,
    destroyComputer: destroy,
    close: () => files.close(),
  };
}
