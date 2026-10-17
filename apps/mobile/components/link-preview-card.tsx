import type { LinkPreviewCard as LinkPreviewCardBlock } from "@rakazo/contracts";
import { previewSiteInitial, previewSiteLabel } from "@rakazo/core";
import { radii, sizes } from "@rakazo/ui-tokens";
import { useEffect, useRef, useState } from "react";
import type { ViewProps } from "react-native";
import {
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { type MobileArtifactTarget, mobileArtifactImageUri } from "../lib/artifact-open";
import {
  linkCardWidth,
  linkPreviewImageFit,
  linkPreviewImageHeight,
  linkPreviewLabel,
  openableLinkPreviewUrl,
} from "../lib/link-preview";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { AVATAR_GAP, THREAD_GUTTER } from "./bot-bubble";
import { NativeSymbol } from "./native-symbol";
import { Surface } from "./surface";

export interface LinkPreviewCardProps {
  card: LinkPreviewCardBlock;
  /** Where the image artifact lives: the thread's bot or group, like every attachment. */
  target: MobileArtifactTarget;
  /** A single-bot thread (82% cap) or a group (88% of the column right of the avatar). */
  mono: boolean;
  /** The bubble's edge the card lines up with: the start for a bot, the end for the person. */
  align: "start" | "end";
  /** The message's long press: its action sheet. */
  onLongPress: () => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}

type ImageState = { uri?: string; failed: boolean };

/**
 * A preview's image (a card's picture, a mention's icon) comes from the artifact the server
 * stored, read through the thread like any attachment: the phone never requests the linked site.
 */
export function useArtifactImage(
  target: MobileArtifactTarget,
  artifactId: string | undefined,
): ImageState & { fail: () => void } {
  const [state, setState] = useState<ImageState>({ failed: false });
  const targetRef = useRef(target);
  targetRef.current = target;
  const targetKey = "groupId" in target ? target.groupId : target.botId;
  useEffect(() => {
    setState({ failed: false });
    if (!artifactId) return;
    let live = true;
    mobileArtifactImageUri(targetRef.current, artifactId, "image/webp").then(
      (uri) => live && setState({ uri, failed: false }),
      () => live && setState({ failed: true }),
    );
    return () => {
      live = false;
    };
  }, [artifactId, targetKey]);
  return { ...state, fail: () => setState((current) => ({ ...current, failed: true })) };
}

/**
 * A page's preview under a message, in the three formats the server picked: `compact` (a thumbnail
 * beside the title), `large` (the image above the text) and `photo` (the image alone, site below).
 * Mirrors `LinkPreviewCard` in `packages/ui-web`. One link for assistive tech, "title, site"; a tap
 * opens the original http(s) link only; a long press is the message's action sheet.
 */
export function LinkPreviewCard({
  card,
  target,
  mono,
  align,
  onLongPress,
  accessibilityActions,
  onAccessibilityAction,
}: LinkPreviewCardProps) {
  const tokens = useMobileTokens();
  const { width: windowWidth } = useWindowDimensions();
  const width = linkCardWidth({
    windowWidth,
    gutter: THREAD_GUTTER,
    avatarColumn: sizes.message + AVATAR_GAP,
    mono,
    byPerson: align === "end",
  });
  const href = openableLinkPreviewUrl(card.url);
  const image = useArtifactImage(target, card.image?.artifactId);
  const site = previewSiteLabel(card.url);
  const imageHeight = linkPreviewImageHeight(card, width);
  // A site icon is drawn whole inside its thumbnail; every other picture fills and crops.
  const fit = linkPreviewImageFit(card);

  const frame = (height: number | undefined, extra: object = {}) => ({
    width: "100%" as const,
    ...(height === undefined ? { aspectRatio: 1 } : { height }),
    backgroundColor: tokens.secondary,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    ...extra,
  });
  const picture = (height: number | undefined, extra: object = {}) => (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={frame(height, extra)}
    >
      {image.uri && !image.failed ? (
        <Image
          source={{ uri: image.uri }}
          resizeMode={fit.resizeMode}
          onError={image.fail}
          style={{
            position: "absolute",
            top: fit.inset,
            bottom: fit.inset,
            left: fit.inset,
            right: fit.inset,
          }}
        />
      ) : image.failed ? (
        <NativeSymbol
          ios="photo"
          android="image-outline"
          size={20}
          color={tokens.mutedForeground}
        />
      ) : card.image ? null : (
        // A compact card without a picture: the site's initial in the same tile (decorative).
        <Text
          style={{
            color: tokens.mutedForeground,
            ...nativeTextStyle("title"),
          }}
        >
          {previewSiteInitial(card.url)}
        </Text>
      )}
    </View>
  );

  const siteLine = (
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
  );
  const title = card.title ? (
    <Text
      numberOfLines={2}
      style={{
        color: tokens.foreground,
        writingDirection: "auto",
        ...nativeTextStyle("rowName", { weight: 500 }),
      }}
    >
      {card.title}
    </Text>
  ) : null;

  return (
    <View style={{ width, alignSelf: align === "end" ? "flex-end" : "flex-start" }}>
      <Pressable
        accessible
        accessibilityRole={href ? "link" : "text"}
        accessibilityLabel={linkPreviewLabel(card)}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        onPress={href ? () => void Linking.openURL(href).catch(() => undefined) : undefined}
        onLongPress={onLongPress}
        // A thumb scrolling the thread past the card does not press it.
        unstable_pressDelay={130}
      >
        {({ pressed }) =>
          card.format === "photo" ? (
            <View
              style={{
                gap: 4,
                borderRadius: radii.bubble,
                // The press fill the other cards use (after the 130 ms delay), not an opacity.
                ...(pressed ? { backgroundColor: tokens.secondary } : null),
              }}
            >
              {picture(imageHeight, {
                borderRadius: radii.bubble,
                overflow: "hidden",
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: tokens.border,
              })}
              <View style={{ paddingHorizontal: 4 }}>{siteLine}</View>
            </View>
          ) : (
            <Surface
              style={{
                overflow: "hidden",
                ...(pressed ? { backgroundColor: tokens.secondary } : null),
              }}
            >
              {card.format === "large" ? (
                <>
                  {picture(imageHeight)}
                  <View style={{ gap: 2, paddingHorizontal: 12, paddingVertical: 10 }}>
                    {title}
                    {siteLine}
                  </View>
                </>
              ) : (
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 10,
                    paddingVertical: 8,
                    paddingStart: 8,
                    paddingEnd: 12,
                  }}
                >
                  <View style={{ width: sizes.linkThumb }}>
                    {picture(undefined, { borderRadius: radii.chip, overflow: "hidden" })}
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    {title}
                    {siteLine}
                  </View>
                </View>
              )}
            </Surface>
          )
        }
      </Pressable>
    </View>
  );
}
