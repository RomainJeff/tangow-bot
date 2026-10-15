import { useState } from "react";
import { Image, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useThemedStyles } from "../lib/native";

/**
 * The person, in the colour of their own bubbles. Mirrors
 * `packages/ui-web/src/user-avatar.tsx`.
 */
export function UserAvatar({
  initials,
  image,
  size,
  fontSize = Math.max(8, Math.round(size * 0.4)),
  style,
}: {
  initials: string;
  /** Profile photo shown instead of the initials, initials on failure. */
  image?: string | null;
  size: number;
  fontSize?: number;
  style?: ViewStyle;
}) {
  const styles = useThemedStyles(createUserAvatarStyles);
  // Tracking the failed source (not a boolean) retries on the next photo.
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const photo = image && image !== failedImage ? image : null;
  return (
    <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2 }, style]}>
      {photo ? (
        <Image
          source={{ uri: photo }}
          style={{ width: size, height: size }}
          resizeMode="cover"
          onError={() => setFailedImage(photo)}
        />
      ) : (
        <Text style={[styles.initials, { fontSize }]}>{initials}</Text>
      )}
    </View>
  );
}

function createUserAvatarStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    disc: {
      backgroundColor: tokens.chatUser,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    initials: {
      color: tokens.chatUserForeground,
      fontWeight: "600",
    },
  });
}
