import { radii, sizes } from "@tangow/ui-tokens";
import { Image, Pressable, Text, View } from "react-native";
import { t } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

const THUMB_SIZE = sizes.composerAttachmentThumb;
const THUMB_RADIUS = radii.card;
const REMOVE_SIZE = sizes.composerRemove;
const FILE_NAME_MAX_WIDTH = sizes.composerAttachmentTile;

/**
 * A pending attachment inside the composer capsule: an image
 * thumbnail, or a file tile with an icon and truncated name, each with a
 * small × disc to remove it. Reused for the row above the text line — the
 * row itself lives in `thread.tsx` (a horizontal `ScrollView`, so it scrolls
 * independently of the text).
 */
export function ComposerAttachment({
  name,
  previewUri,
  onRemove,
  disabled = false,
}: {
  name: string;
  previewUri?: string;
  onRemove: () => void;
  /** Inert during dictation: the × stays visible but stops responding, and
   * says so to VoiceOver instead of announcing a working button. */
  disabled?: boolean;
}) {
  const tokens = useMobileTokens();
  return (
    <View style={{ alignSelf: "flex-start" }}>
      {previewUri ? (
        <Image
          source={{ uri: previewUri }}
          style={{ width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: THUMB_RADIUS }}
        />
      ) : (
        <View
          style={{
            height: THUMB_SIZE,
            borderRadius: THUMB_RADIUS,
            backgroundColor: tokens.secondary,
            flexDirection: "row",
            alignItems: "center",
            gap: 6,
            paddingHorizontal: 10,
          }}
        >
          <NativeSymbol ios="paperclip" android="attach" size={16} color={tokens.foreground} />
          <Text
            numberOfLines={1}
            style={{
              color: tokens.foreground,
              maxWidth: FILE_NAME_MAX_WIDTH,
              ...nativeTextStyle("label"),
            }}
          >
            {name}
          </Text>
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Remove {name}", { name })}
        accessibilityState={{ disabled }}
        disabled={disabled}
        hitSlop={11}
        onPress={onRemove}
        style={{
          position: "absolute",
          top: -6,
          end: -6,
          width: REMOVE_SIZE,
          height: REMOVE_SIZE,
          borderRadius: radii.pill,
          backgroundColor: tokens.primary,
          borderWidth: 2,
          borderColor: tokens.surface,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <NativeSymbol ios="xmark" android="close" size={11} color={tokens.primaryForeground} />
      </Pressable>
    </View>
  );
}
