import type { ComposerLinkPreviewView } from "@tangow/core";
import { previewSiteInitial } from "@tangow/core";
import { radii, sizes } from "@tangow/ui-tokens";
import { memo } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { t } from "../lib/i18n";
import { composerThumbnailFit } from "../lib/link-preview";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

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
  width,
}: {
  view: Extract<ComposerLinkPreviewView, { status: "ready" }>;
  onRemove: () => void;
  /** The attachments row's width: a horizontal scroll view does not bound its children. */
  width?: number;
  /** Inert during dictation: the × stays visible but stops responding. */
  disabled?: boolean;
}) {
  const tokens = useMobileTokens();
  const { thumbnail, site } = view;
  // A site icon is drawn whole inside the tile; every other thumbnail fills and crops.
  const fit = composerThumbnailFit(view.thumbnailFit);
  return (
    // The card fills the composer row (never wider than a link card), and leaves room in its
    // corner for the remove disc so neither the title nor the disc is clipped by the capsule.
    <View
      style={{
        width: width === undefined ? undefined : Math.min(width, sizes.linkCard),
        maxWidth: sizes.linkCard,
        paddingTop: 6,
        paddingEnd: 6,
      }}
    >
      <View
        accessible
        accessibilityLabel={[view.title, site].filter(Boolean).join(", ")}
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
        {thumbnail ? (
          <View
            accessibilityElementsHidden
            style={{
              width: THUMB,
              height: THUMB,
              borderRadius: radii.chip,
              overflow: "hidden",
              backgroundColor: tokens.secondary,
            }}
          >
            <Image
              source={{ uri: thumbnail }}
              resizeMode={fit.resizeMode}
              style={{ flex: 1, margin: fit.inset }}
            />
          </View>
        ) : (
          // No picture: the site's initial in the same tile, as on the card (decorative).
          <View
            accessibilityElementsHidden
            style={{
              width: THUMB,
              height: THUMB,
              borderRadius: radii.chip,
              backgroundColor: tokens.secondary,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: tokens.mutedForeground, ...nativeTextStyle("title") }}>
              {previewSiteInitial(view.url)}
            </Text>
          </View>
        )}
        <View style={{ flexShrink: 1, minWidth: 0 }}>
          {view.title ? (
            <Text
              numberOfLines={2}
              style={{
                color: tokens.foreground,
                writingDirection: "auto",
                ...nativeTextStyle("rowName", { weight: 500 }),
              }}
            >
              {view.title}
            </Text>
          ) : null}
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
          top: 0,
          end: 0,
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
