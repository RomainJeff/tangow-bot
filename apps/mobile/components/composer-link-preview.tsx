import type { ComposerLinkPreviewView } from "@rakazo/core";
import { previewSiteLabel } from "@rakazo/core";
import { radii, sizes } from "@rakazo/ui-tokens";
import { memo } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { t } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";
import { ShimmerText } from "./shimmer-text";

const THUMB = sizes.linkThumb;
const REMOVE_SIZE = sizes.composerRemove;

/**
 * What the first complete link of the draft will look like, in the row of the composer's pending
 * attachments: always the compact card, whatever format the server picked. Not a link (a tap opens
 * nothing); its × takes the preview off this message. Mirrors `ComposerLinkPreview` in
 * `packages/ui-web`. The only picture is the inline WebP thumbnail the controller accepted.
 */
export const ComposerLinkPreview = memo(function ComposerLinkPreview({
  view,
  onRemove,
  disabled = false,
}: {
  view: Exclude<ComposerLinkPreviewView, { status: "idle" }>;
  onRemove: () => void;
  /** Inert during dictation: the × stays visible but stops responding. */
  disabled?: boolean;
}) {
  const tokens = useMobileTokens();
  const loading = view.status === "loading";
  const thumbnail = view.status === "ready" ? view.thumbnail : undefined;
  // While the page is read the host is all there is to say, and the one thing that moves.
  const site = view.status === "ready" ? view.site : previewSiteLabel(view.url);
  return (
    <View style={{ alignSelf: "flex-start", maxWidth: sizes.linkCard }}>
      <View
        accessible
        accessibilityLabel={
          view.status === "ready" ? [view.title, view.site].filter(Boolean).join(", ") : site
        }
        style={{
          height: sizes.composerAttachmentThumb,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          padding: 4,
          paddingEnd: 12,
          borderRadius: radii.card,
          backgroundColor: tokens.background,
        }}
      >
        {loading ? (
          <View
            style={{
              width: THUMB,
              height: THUMB,
              borderRadius: radii.chip,
              backgroundColor: tokens.secondary,
            }}
          />
        ) : thumbnail ? (
          <Image
            source={{ uri: thumbnail }}
            accessibilityElementsHidden
            style={{ width: THUMB, height: THUMB, borderRadius: radii.chip }}
          />
        ) : (
          <View style={{ width: 4 }} />
        )}
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          {view.status === "ready" && view.title ? (
            <Text
              numberOfLines={1}
              style={{
                color: tokens.foreground,
                writingDirection: "auto",
                ...nativeTextStyle("rowName", { weight: 500 }),
              }}
            >
              {view.title}
            </Text>
          ) : null}
          {loading ? (
            <ShimmerText
              style={{
                color: tokens.mutedForeground,
                writingDirection: "ltr",
                ...nativeTextStyle("meta"),
              }}
            >
              {site}
            </ShimmerText>
          ) : (
            <Text
              numberOfLines={1}
              ellipsizeMode="head"
              style={{
                color: tokens.mutedForeground,
                writingDirection: "ltr",
                ...nativeTextStyle("meta"),
              }}
            >
              {site}
            </Text>
          )}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Remove preview")}
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
});
