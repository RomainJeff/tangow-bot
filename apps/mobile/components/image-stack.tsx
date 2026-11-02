import type { StackImage } from "@rakazo/core";
import { motion, radii, sizes } from "@rakazo/ui-tokens";
import { Link } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewProps } from "react-native";
import {
  Image,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { MobileArtifactTarget } from "../lib/artifact-open";
import { CHAT_MOTION, SPRING_TIMING, useChatReducedMotion } from "../lib/chat-motion";
import { useI18n } from "../lib/i18n";
import type { StackCardModel } from "../lib/image-stack";
import {
  coverFromTop,
  IMAGE_STACK,
  STACK_ROOM,
  stackCards,
  stackFrame,
  stackStepX,
} from "../lib/image-stack";
import { IMAGE_VIEWER_HREF, imageLabel, useImageZoom } from "../lib/image-viewer";
import { linkCardWidth } from "../lib/link-preview";
import { useMobileTokens } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { AVATAR_GAP, THREAD_GUTTER } from "./bot-bubble";
import { useArtifactImage } from "./link-preview-card";
import { NativeSymbol } from "./native-symbol";

/** The count shows from this many images: a pile of three reads at a glance. */
const COUNT_FROM = 4;

/** Pictures already drawn once this session come back at full opacity, so a row the list re-mounts does not fade in again. */
const drawn = new Set<string>();

export interface ImageStackProps {
  /** Oldest to newest: the newest is the front. */
  images: readonly StackImage[];
  target: MobileArtifactTarget;
  /** The bubble's edge the stack lines up with: the start for a bot, the end for the person. */
  align: "start" | "end";
  /** A single-bot thread (82% cap) or a group (88% of the column right of the avatar). */
  mono: boolean;
  /** Who sent the images, for assistive tech. */
  author: string;
  /** True only in the render pass a newer image joined this stack, never when it merely mounts. */
  arrival: boolean;
  /**
   * A tap hands the viewer its list. By default the stack is a link to the viewer, so the zoom
   * transition can attach; `zoom={false}` makes it a plain press for a stack inside a native modal,
   * which a link would dismiss.
   */
  onOpen: () => void;
  zoom?: boolean;
  /** The front message's long press: its action sheet. */
  onLongPress?: () => void;
  accessibilityActions?: ViewProps["accessibilityActions"];
  onAccessibilityAction?: ViewProps["onAccessibilityAction"];
}

/**
 * A message's images, and those that follow it, as one pile: the newest in a fixed 4:3 frame, up to
 * two earlier ones peeking out toward the thread's centre. The frame and the room for the peeking
 * cards are kept whatever the count, so loading or adding an image never moves the rows around it.
 */
export function ImageStack({
  images,
  target,
  align,
  mono,
  author,
  arrival,
  onOpen,
  zoom = true,
  onLongPress,
  accessibilityActions,
  onAccessibilityAction,
}: ImageStackProps) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const zoomAvailable = useImageZoom();
  const { width: windowWidth } = useWindowDimensions();
  const frame = stackFrame(
    linkCardWidth({
      windowWidth,
      gutter: THREAD_GUTTER,
      avatarColumn: sizes.message + AVATAR_GAP,
      mono,
      byPerson: align === "end",
    }),
  );
  const direction = align === "end" ? -1 : 1;
  const front = images[images.length - 1];
  const [retryFront, setRetryFront] = useState<(() => void) | undefined>();
  const reportFront = useCallback((retry: (() => void) | undefined) => {
    setRetryFront(() => retry);
  }, []);
  if (!front) return null;

  const label = imageLabel(t, images.length, images.length, author);

  const frameView = (
    <View
      collapsable={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: frame.width,
        height: frame.height,
        marginStart: align === "end" ? STACK_ROOM : 0,
      }}
    >
      {stackCards(images).map((card) => (
        <StackCard
          key={card.key}
          card={card}
          frame={frame}
          direction={direction}
          target={target}
          arrival={arrival}
          onFront={card.depth === 0 ? reportFront : undefined}
        />
      ))}
      {images.length >= COUNT_FROM ? (
        <View style={[styles.count, { backgroundColor: tokens.overlay, borderRadius: radii.pill }]}>
          <NativeSymbol
            ios="square.stack"
            android="layers-outline"
            size={14}
            color={tokens.chatUserForeground}
          />
          <Text style={{ color: tokens.chatUserForeground, ...nativeTextStyle("meta") }}>
            {images.length}
          </Text>
        </View>
      ) : null}
    </View>
  );

  const tap = (event?: { preventDefault: () => void }) => {
    if (retryFront) {
      event?.preventDefault();
      retryFront();
      return;
    }
    // Drop the keyboard before the viewer covers the thread: iOS would raise it again on close and
    // shift the thread under the image flying back into its stack.
    Keyboard.dismiss();
    onOpen();
  };
  const stack = (
    <Pressable
      accessible
      role="button"
      accessibilityLabel={label}
      accessibilityHint={retryFront ? t("Retry") : undefined}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      {...(zoom ? null : { onPress: tap })}
      onLongPress={onLongPress}
      // A thumb scrolling the thread past the stack does not press it.
      unstable_pressDelay={130}
      style={{
        width: frame.width + STACK_ROOM,
        height: frame.height,
        alignSelf: align === "end" ? "flex-end" : "flex-start",
      }}
    >
      {zoom && zoomAvailable ? <Link.AppleZoom>{frameView}</Link.AppleZoom> : frameView}
    </Pressable>
  );
  // The front frame is the zoom's source: the viewer opens out of it and closes back into it. When
  // the list has unmounted this row, the source is gone and the system closes with a plain fade.
  return zoom ? (
    <Link href={IMAGE_VIEWER_HREF} asChild onPress={tap}>
      {stack}
    </Link>
  ) : (
    stack
  );
}

function StackCard({
  card,
  frame,
  direction,
  target,
  arrival,
  onFront,
}: {
  card: StackCardModel;
  frame: { width: number; height: number };
  direction: 1 | -1;
  target: MobileArtifactTarget;
  arrival: boolean;
  onFront?: (retry: (() => void) | undefined) => void;
}) {
  const tokens = useMobileTokens();
  const reducedMotion = useChatReducedMotion();
  const { image, depth } = card;
  // Only the front and the cards peeking behind it load; one that moved on keeps what it loaded.
  const loads = useRef(false);
  if (depth <= IMAGE_STACK.peekLevels) loads.current = true;
  const picture = useArtifactImage(
    target,
    loads.current ? image.artifactId : undefined,
    image.mimeType,
  );
  const [natural, setNatural] = useState<{ width: number; height: number }>();
  const stepX = stackStepX(frame.width);

  // A card mounted in the pass its stack grew is the newcomer; one mounted any other time is not.
  const entering = useRef(arrival);
  const appear = useSharedValue(entering.current ? 0 : 1);
  const level = useSharedValue(entering.current ? depth - 1 : depth);
  useEffect(() => {
    level.value = arrival && !reducedMotion ? withTiming(depth, SPRING_TIMING) : depth;
    if (entering.current) {
      entering.current = false;
      appear.value = withTiming(1, {
        duration: reducedMotion ? CHAT_MOTION.reducedFadeMs : motion.arrive,
      });
    }
  }, [depth]);

  const cardStyle = useAnimatedStyle(() => ({
    opacity:
      appear.value *
      interpolate(
        level.value,
        [IMAGE_STACK.peekLevels, IMAGE_STACK.peekLevels + 1],
        [1, 0],
        "clamp",
      ),
    transform: [
      { translateX: direction * Math.max(level.value, 0) * stepX },
      { translateY: Math.min(level.value, 0) * IMAGE_STACK.drop },
      { scale: 1 - level.value * IMAGE_STACK.shrink },
    ],
  }));

  const fade = useSharedValue(0);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));
  const showPicture = picture.uri && !picture.failed;
  const failed = picture.failed;
  const { retry } = picture;
  useEffect(() => {
    if (!onFront) return;
    onFront(failed ? retry : undefined);
    return () => onFront(undefined);
  }, [onFront, failed, retry]);

  // Until the picture's size is known it fills the frame, hidden, so the list still loads it.
  const place = natural
    ? coverFromTop(frame, natural)
    : { left: 0, top: 0, width: frame.width, height: frame.height };
  return (
    <Animated.View
      style={[
        styles.card,
        {
          width: frame.width,
          height: frame.height,
          borderRadius: radii.bubble,
          backgroundColor: tokens.muted,
          borderColor: tokens.border,
          zIndex: IMAGE_STACK.peekLevels + 2 - depth,
        },
        cardStyle,
      ]}
    >
      {showPicture && picture.uri ? (
        <Animated.View style={[styles.picture, place, fadeStyle]}>
          <Image
            accessibilityIgnoresInvertColors
            source={{ uri: picture.uri }}
            resizeMode="cover"
            onError={picture.fail}
            onLoad={(event) => {
              const { width, height } = event.nativeEvent.source;
              setNatural({ width, height });
              const key = `${picture.uri}`;
              fade.value = drawn.has(key)
                ? 1
                : withTiming(1, {
                    duration: reducedMotion ? CHAT_MOTION.reducedFadeMs : motion.arrive,
                  });
              drawn.add(key);
            }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
      {failed && depth === 0 ? (
        <View style={styles.retry}>
          <NativeSymbol
            ios="arrow.clockwise"
            android="refresh"
            size={20}
            color={tokens.mutedForeground}
          />
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    top: 0,
    left: 0,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  picture: { position: "absolute" },
  retry: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  count: {
    position: "absolute",
    right: 8,
    bottom: 8,
    zIndex: IMAGE_STACK.peekLevels + 3,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
