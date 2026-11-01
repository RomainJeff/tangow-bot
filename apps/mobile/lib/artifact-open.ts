import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { rpc } from "./api";
import { artifactCacheFileName } from "./artifact-file";
import { t } from "./i18n";

export type MobileArtifactTarget = { botId: string } | { groupId: string };

const inFlight = new Map<string, Promise<File>>();

/** Downloads an artifact into the cache. Two loads of the same one wait on a single download, so they never write its file at once. */
function cacheMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<File> {
  const name = artifactCacheFileName(artifactId, mimeType);
  const pending = inFlight.get(name);
  if (pending) return pending;
  const download = (async () => {
    const artifact = await rpc<{ contentBase64: string }>("artifacts/get", {
      ...target,
      artifactId,
    });
    const file = new File(Paths.cache, name);
    file.create({ overwrite: true });
    file.write(artifact.contentBase64, { encoding: "base64" });
    return file;
  })().finally(() => inFlight.delete(name));
  inFlight.set(name, download);
  return download;
}

/** An artifact never changes, so a file already in the cache is reused instead of fetched again. */
async function cachedMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<File> {
  const cached = new File(Paths.cache, artifactCacheFileName(artifactId, mimeType));
  return cached.exists && cached.size > 0
    ? cached
    : cacheMobileArtifact(target, artifactId, mimeType);
}

/**
 * A thread image artifact as a local file uri, for drawing inline. An artifact never changes, so
 * a file already in the cache is reused instead of fetched again each time its row mounts.
 */
export async function mobileArtifactImageUri(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
  refetch = false,
): Promise<string> {
  return (
    await (refetch ? cacheMobileArtifact : cachedMobileArtifact)(target, artifactId, mimeType)
  ).uri;
}

export async function readMobileArtifactText(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  return (await cachedMobileArtifact(target, artifactId, mimeType)).text();
}

export async function openMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const file = await cachedMobileArtifact(target, artifactId, mimeType);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType });
    return;
  }
  throw new Error(t("Saved {name} locally", { name }));
}
