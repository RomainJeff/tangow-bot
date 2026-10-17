import { sizes } from "@rakazo/ui-tokens";
import { Image, StyleSheet } from "react-native";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { useArtifactImage } from "./link-preview-card";
import { NativeSymbol } from "./native-symbol";

/**
 * What fills a link mention's 16 pt frame: the site's icon from the thread's artifact, never a
 * remote URL, drawn whole; only the tile while it loads; the link glyph at 62.5% in `tint` when
 * the site gave no icon or it cannot be read.
 */
export function LinkMentionIcon({
  target,
  artifactId,
  tint,
}: {
  target: MobileArtifactTarget;
  artifactId: string | undefined;
  tint: string;
}) {
  const image = useArtifactImage(target, artifactId);
  if (!artifactId || image.failed) {
    return (
      <NativeSymbol
        ios="link"
        android="link-outline"
        size={sizes.linkMentionIcon * 0.625}
        color={tint}
        weight="bold"
      />
    );
  }
  return image.uri ? (
    <Image
      source={{ uri: image.uri }}
      resizeMode="contain"
      onError={image.fail}
      style={StyleSheet.absoluteFill}
    />
  ) : null;
}
