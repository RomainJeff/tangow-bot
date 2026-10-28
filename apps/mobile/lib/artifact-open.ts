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

/**
 * A thread image artifact as a local file uri, for drawing inline. An artifact never changes, so
 * a file already in the cache is reused instead of fetched again each time its row mounts.
 */
export async function mobileArtifactImageUri(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  const cached = new File(Paths.cache, artifactCacheFileName(artifactId, mimeType));
  if (cached.exists && cached.size > 0) return cached.uri;
  return (await cacheMobileArtifact(target, artifactId, mimeType)).uri;
}

export async function readMobileArtifactText(
  target: MobileArtifactTarget,
  artifactId: string,
  mimeType: string,
): Promise<string> {
  const cached = new File(Paths.cache, artifactCacheFileName(artifactId, mimeType));
  const file =
    cached.exists && cached.size > 0
      ? cached
      : await cacheMobileArtifact(target, artifactId, mimeType);
  return file.text();
}

export async function openMobileArtifact(
  target: MobileArtifactTarget,
  artifactId: string,
  name: string,
  mimeType: string,
): Promise<void> {
  const file = await cacheMobileArtifact(target, artifactId, mimeType);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(file.uri, { mimeType });
    return;
  }
  throw new Error(t("Saved {name} locally", { name }));
}
