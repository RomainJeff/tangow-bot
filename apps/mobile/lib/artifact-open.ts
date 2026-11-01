import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { rpc } from "./api";
import { artifactCacheFileName } from "./artifact-file";
import { t } from "./i18n";

export type MobileArtifactTarget = { botId: string } | { groupId: string };

async function cacheMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<File> {
  const artifact = await rpc<{ contentBase64: string }>("artifacts/get", {
    ...target,
    artifactId,
  });
  const file = new File(Paths.cache, artifactCacheFileName(artifactId, mimeType));
  file.create({ overwrite: true });
  file.write(artifact.contentBase64, { encoding: "base64" });
  return file;
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
  const cached = new File(Paths.cache, artifactCacheFileName(artifactId, mimeType));
  if (!refetch && cached.exists && cached.size > 0) return cached.uri;
  return (await cacheMobileArtifact(target, artifactId, mimeType)).uri;
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
