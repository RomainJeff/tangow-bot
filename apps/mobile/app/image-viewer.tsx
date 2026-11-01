import type { StackImage } from "@rakazo/core";
import { threadTimeMarkerLabel } from "@rakazo/core";
import { darkTokens, radii, sizes, space } from "@rakazo/ui-tokens";
import { Link, Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import {
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { THREAD_GUTTER } from "../components/bot-bubble";
import { useArtifactImage } from "../components/link-preview-card";
import { NativeSymbol } from "../components/native-symbol";
import { openMobileArtifact } from "../lib/artifact-open";
import { useChatReducedMotion } from "../lib/chat-motion";
import { dateLocaleForUi, t, useI18n } from "../lib/i18n";
import { stackFrame } from "../lib/image-stack";
import {
  containRect,
  type ImageViewerPayload,
  imageViewerPayload,
  type Size,
} from "../lib/image-viewer";
import { nativeTextStyle } from "../lib/typography";

const THUMB = sizes.mobileStack;
const THUMB_GAP = 8;
const BUTTON = sizes.composerTarget;
const BAND_GAP = 12;

/**
 * The stack's images full screen, on the dark surface of the app in both themes. The list is the one
 * it was opened with: an image that arrives afterwards does not change what is paged through.
 */
export default function ImageViewerScreen() {
  const router = useRouter();
  const reducedMotion = useChatReducedMotion();
  const [opened] = useState(imageViewerPayload);
  useEffect(() => {
    if (!opened) router.back();
  }, [opened, router]);
  return (
    <>
      <Stack.Screen options={{ animation: reducedMotion ? "fade" : "default" }} />
      <StatusBar style="light" />
      {opened ? <Viewer opened={opened} /> : null}
    </>
  );
}

function Viewer({ opened }: { opened: ImageViewerPayload }) {
  const { images, startIndex, author, target } = opened;
  const router = useRouter();
  const { t } = useI18n();
  const reducedMotion = useChatReducedMotion();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(startIndex);
  const [natural, setNatural] = useState<Record<string, Size>>({});
  const [sharing, setSharing] = useState(false);
  const pager = useRef<FlatList<StackImage>>(null);
  const strip = useRef<FlatList<StackImage>>(null);
  const total = images.length;
  const current = images[index];

  const topBand = insets.top + space.header;
  const bottomBand =
    insets.bottom + BAND_GAP + BUTTON + (total > 1 ? THUMB + BAND_GAP : 0) + BAND_GAP;
  const area = { width, height: Math.max(0, height - topBand - bottomBand) };

  useEffect(() => {
    if (total > 1) {
      strip.current?.scrollToIndex({ index, viewPosition: 0.5, animated: !reducedMotion });
    }
  }, [index, total, reducedMotion]);

  if (!current) return null;

  const label = (n: number) =>
    total > 1
      ? t("Image {n} of {total}, from {author}", { n, total, author })
      : t("Image, from {author}", { author });

  const goTo = (next: number) => {
    setIndex(next);
    pager.current?.scrollToIndex({ index: next, animated: !reducedMotion });
  };
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / width);
    if (next >= 0 && next < total) setIndex(next);
  };
  const share = () => {
    if (sharing) return;
    setSharing(true);
    openMobileArtifact(target, current.artifactId, current.name, current.mimeType)
      .catch((err) =>
        Alert.alert(
          t("Could not open image"),
          err instanceof Error ? err.message : t("Try again."),
        ),
      )
      .finally(() => setSharing(false));
  };

  const size = natural[current.artifactId];
  const zoomRect = size
    ? (() => {
        const fit = containRect(area, size);
        return { ...fit, top: topBand + fit.top };
      })()
    : { left: 0, top: topBand, ...area };
  const when = threadTimeMarkerLabel(current.ts, {
    locale: dateLocaleForUi(),
    today: t("Today"),
    yesterday: t("Yesterday"),
  });

  return (
    <View style={styles.screen}>
      <Link.AppleZoomTarget>
        <View collapsable={false} pointerEvents="none" style={[styles.zoomTarget, zoomRect]} />
      </Link.AppleZoomTarget>
      <FlatList
        ref={pager}
        data={images}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        keyExtractor={(image) => `${image.messageId}:${image.artifactId}`}
        initialScrollIndex={startIndex}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={settle}
        windowSize={3}
        renderItem={({ item, index: i }) => (
          <ViewerPage
            image={item}
            target={target}
            label={label(i + 1)}
            area={area}
            top={topBand}
            width={width}
            near={Math.abs(i - index) <= 1}
            current={i === index}
            onNatural={(artifactId, next) => setNatural((all) => ({ ...all, [artifactId]: next }))}
          />
        )}
      />
      <View pointerEvents="box-none" style={[styles.header, { paddingTop: insets.top }]}>
        <View pointerEvents="none" style={styles.who}>
          <Text numberOfLines={1} style={[styles.author, nativeTextStyle("author")]}>
            {author}
          </Text>
          <Text numberOfLines={1} style={[styles.when, nativeTextStyle("time")]}>
            {when}
          </Text>
        </View>
        <View style={[styles.close, { top: insets.top + (space.header - BUTTON) / 2 }]}>
          <RoundButton
            label={t("Close")}
            ios="xmark"
            android="close"
            onPress={() => router.back()}
          />
        </View>
      </View>
      <View
        pointerEvents="box-none"
        style={[styles.bottom, { paddingBottom: insets.bottom + BAND_GAP }]}
      >
        {total > 1 ? (
          <FlatList
            ref={strip}
            data={images}
            horizontal
            showsHorizontalScrollIndicator={false}
            keyExtractor={(image) => `${image.messageId}:${image.artifactId}`}
            getItemLayout={(_, i) => ({
              length: THUMB + THUMB_GAP,
              offset: (THUMB + THUMB_GAP) * i,
              index: i,
            })}
            initialNumToRender={12}
            windowSize={5}
            style={styles.strip}
            contentContainerStyle={{ paddingHorizontal: THREAD_GUTTER, gap: THUMB_GAP }}
            renderItem={({ item, index: i }) => (
              <Thumb
                image={item}
                target={target}
                label={label(i + 1)}
                selected={i === index}
                onPress={() => goTo(i)}
              />
            )}
          />
        ) : null}
        <View style={styles.actions}>
          <RoundButton
            label={t("Share")}
            ios="square.and.arrow.up"
            android="share-outline"
            disabled={sharing}
            onPress={share}
          />
        </View>
      </View>
    </View>
  );
}

function ViewerPage({
  image,
  target,
  label,
  area,
  top,
  width,
  near,
  current,
  onNatural,
}: {
  image: StackImage;
  target: ImageViewerPayload["target"];
  label: string;
  area: Size;
  top: number;
  width: number;
  near: boolean;
  current: boolean;
  onNatural: (artifactId: string, size: Size) => void;
}) {
  // Only the current page and its neighbours load; one that moved on keeps what it loaded.
  const loads = useRef(false);
  if (near) loads.current = true;
  const picture = useArtifactImage(
    target,
    loads.current ? image.artifactId : undefined,
    image.mimeType,
  );
  const failed = picture.failed;
  const placeholder = stackFrame(width - THREAD_GUTTER * 2);
  return (
    <Pressable
      accessible
      accessibilityRole={failed ? "button" : "image"}
      accessibilityLabel={label}
      accessibilityHint={failed ? t("Retry") : undefined}
      accessibilityElementsHidden={!current}
      importantForAccessibility={current ? "yes" : "no-hide-descendants"}
      disabled={!failed}
      onPress={picture.retry}
      style={{ width, paddingTop: top, height: top + area.height, justifyContent: "center" }}
    >
      {picture.uri && !failed ? (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: picture.uri }}
          resizeMode="contain"
          onError={picture.fail}
          onLoad={(event) => {
            const { width: w, height: h } = event.nativeEvent.source;
            onNatural(image.artifactId, { width: w, height: h });
          }}
          style={{ width, height: area.height }}
        />
      ) : (
        <View
          style={[
            styles.placeholder,
            { width: placeholder.width, height: placeholder.height, alignSelf: "center" },
          ]}
        >
          {failed ? (
            <NativeSymbol
              ios="arrow.clockwise"
              android="refresh"
              size={24}
              color={darkTokens.mutedForeground}
            />
          ) : null}
        </View>
      )}
    </Pressable>
  );
}

function Thumb({
  image,
  target,
  label,
  selected,
  onPress,
}: {
  image: StackImage;
  target: ImageViewerPayload["target"];
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const picture = useArtifactImage(target, image.artifactId, image.mimeType);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.thumb,
        selected ? { borderColor: darkTokens.foreground, opacity: 1 } : styles.thumbIdle,
      ]}
    >
      {picture.uri && !picture.failed ? (
        <Image
          accessibilityIgnoresInvertColors
          source={{ uri: picture.uri }}
          resizeMode="cover"
          onError={picture.fail}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </Pressable>
  );
}

function RoundButton({
  label,
  ios,
  android,
  disabled,
  onPress,
}: {
  label: string;
  ios: string;
  android: Parameters<typeof NativeSymbol>[0]["android"];
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        { backgroundColor: pressed ? darkTokens.pressed : darkTokens.secondary },
      ]}
    >
      <NativeSymbol
        ios={ios}
        android={android}
        size={17}
        color={darkTokens.secondaryForeground}
        weight="semibold"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: darkTokens.background },
  zoomTarget: { position: "absolute" },
  header: { position: "absolute", top: 0, left: 0, right: 0 },
  who: {
    height: space.header,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: BUTTON + THREAD_GUTTER * 2,
  },
  author: { color: darkTokens.foreground },
  when: { color: darkTokens.mutedForeground },
  close: { position: "absolute", right: THREAD_GUTTER },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, gap: BAND_GAP },
  strip: { flexGrow: 0 },
  actions: { paddingHorizontal: THREAD_GUTTER, alignItems: "flex-start" },
  round: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholder: {
    borderRadius: radii.bubble,
    backgroundColor: darkTokens.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: radii.row,
    overflow: "hidden",
    borderWidth: sizes.selectedRing,
    borderColor: "transparent",
    backgroundColor: darkTokens.muted,
  },
  thumbIdle: { opacity: 0.6 },
});
