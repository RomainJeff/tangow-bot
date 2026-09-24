import { SPECIAL_BOT_COLORS } from "@rakazo/contracts";
import {
  LAUNCH_CHOREOGRAPHY,
  LAUNCH_LOOP_FROM_INDEX,
  LAUNCH_WAKE_UP_MINIMUM_SECONDS,
  SHAPES,
} from "@rakazo/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, useColorScheme, View } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { mobileTokens } from "../lib/appearance";
import { loadMainBotCache, type MainBotCacheEntry } from "../lib/main-bot-cache";
import { OrganicAvatar } from "./bot-avatar";

const HALO_SIZE = 132;
const BOT_SIZE = 96;
const BAR_WIDTH = 72;
const BAR_HEIGHT = 2;
const BAR_BOTTOM = 64;
const BAR_INDICATOR_WIDTH = BAR_WIDTH * 0.4;
const FADE_OUT_MS = 250;
const PLACEHOLDER_SHAPE_ID = "cercle";
const [INK, WHITE] = SPECIAL_BOT_COLORS;

function placeholderBot(dark: boolean): MainBotCacheEntry {
  return {
    color: dark ? WHITE : INK,
    shapeSeed: SHAPES.findIndex((shape) => shape.id === PLACEHOLDER_SHAPE_ID),
  };
}

/** Adds an alpha channel to an existing token/prop hex colour — never a new colour. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const v = parseInt(clean, 16);
  const [r, g, b] = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The animated launch splash: covers the app while it boots (`ready === false`),
 * playing the bot's wake-up choreography, and fades out once the app is ready
 * and the wake-up has played. It starts on the native splash's frozen frame so
 * the handoff has no visible jump, then morphs the bot into the user's cached
 * main bot.
 */
export function LaunchSplash({
  ready,
  onHidden,
  onLayout,
}: {
  ready: boolean;
  onHidden: () => void;
  /** Fired once this view has laid out, so the caller can reveal it before hiding the native splash. */
  onLayout?: () => void;
}) {
  const reducedMotion = useReducedMotion();
  // Follow the device theme, not the in-app Appearance preference: the native
  // splash can only see the device theme, so matching it keeps the handoff
  // seamless, and any switch to the in-app theme happens under the fade-out.
  const scheme = useColorScheme();
  const tokens = mobileTokens("system", scheme);
  const dark = scheme !== "light";

  const [cachedBot, setCachedBot] = useState<MainBotCacheEntry | null>(null);
  const bot = cachedBot ?? placeholderBot(dark);
  const [stepIndex, setStepIndex] = useState(0);
  const [wakeUpElapsed, setWakeUpElapsed] = useState(reducedMotion);
  const hiding = useRef(false);

  const opacity = useSharedValue(1);
  const haloScale = useSharedValue(0.92);
  const haloOpacity = useSharedValue(0.9);
  const barTranslate = useSharedValue(-BAR_INDICATOR_WIDTH);

  // The cached main bot loads fast (SecureStore), but never blocks: the placeholder
  // shows until it resolves, and stays if there is no cached bot yet.
  useEffect(() => {
    let cancelled = false;
    void loadMainBotCache().then((entry) => {
      if (!cancelled && entry) setCachedBot(entry);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Step through the wake-up choreography, looping from LAUNCH_LOOP_FROM_INDEX
  // if the boot runs long. Skipped entirely under reduced motion.
  useEffect(() => {
    if (reducedMotion) return;
    const step = LAUNCH_CHOREOGRAPHY[stepIndex];
    if (!step) return;
    const timer = setTimeout(
      () => {
        const next =
          stepIndex + 1 >= LAUNCH_CHOREOGRAPHY.length ? LAUNCH_LOOP_FROM_INDEX : stepIndex + 1;
        setStepIndex(next);
      },
      Math.round(step.holdSeconds * 1000),
    );
    return () => clearTimeout(timer);
  }, [stepIndex, reducedMotion]);

  // The splash never disappears before the wake-up's minimum time, so a fast
  // boot doesn't flash past it.
  useEffect(() => {
    if (reducedMotion) return;
    const timer = setTimeout(
      () => setWakeUpElapsed(true),
      Math.round(LAUNCH_WAKE_UP_MINIMUM_SECONDS * 1000),
    );
    return () => clearTimeout(timer);
  }, [reducedMotion]);

  // Progressive disclosure: the loader only appears when the app is still not
  // ready once the wake-up has played, i.e. when there is a real wait to show.
  const showLoader = wakeUpElapsed && !ready;

  useEffect(() => {
    if (reducedMotion) return;
    haloScale.value = withRepeat(
      withTiming(1.3, { duration: 2600, easing: Easing.inOut(Easing.ease) }),
      -1,
      false,
    );
    haloOpacity.value = withRepeat(
      withTiming(0, { duration: 2600, easing: Easing.inOut(Easing.ease) }),
      -1,
      false,
    );
    barTranslate.value = withRepeat(
      withTiming(BAR_INDICATOR_WIDTH * 2.5, {
        duration: 1400,
        easing: Easing.bezier(0.4, 0, 0.2, 1),
      }),
      -1,
      false,
    );
  }, [reducedMotion, haloScale, haloOpacity, barTranslate]);

  useEffect(() => {
    if (hiding.current || !ready || !wakeUpElapsed) return;
    hiding.current = true;
    opacity.value = withTiming(0, { duration: FADE_OUT_MS }, (finished) => {
      if (finished) runOnJS(onHidden)();
    });
  }, [ready, wakeUpElapsed, opacity, onHidden]);

  const containerStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const haloStyle = useAnimatedStyle(() => ({
    transform: [{ scale: haloScale.value }],
    opacity: haloOpacity.value,
  }));
  const barIndicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: barTranslate.value }],
  }));

  // Memoized so the avatar's engine effect only re-runs when the step actually changes.
  const drive = useMemo(() => {
    const step = reducedMotion ? null : LAUNCH_CHOREOGRAPHY[stepIndex];
    return step ? { mood: step.mood, look: step.look } : null;
  }, [reducedMotion, stepIndex]);
  const trackAlpha = dark ? 0.1 : 0.07;

  return (
    <Animated.View
      style={[styles.container, { backgroundColor: tokens.background }, containerStyle]}
      pointerEvents="none"
      onLayout={onLayout}
    >
      <View style={styles.center}>
        <Animated.View
          style={[
            styles.halo,
            { backgroundColor: withAlpha(bot.color, 0.18) },
            reducedMotion ? styles.haloStatic : haloStyle,
          ]}
        />
        <OrganicAvatar
          color={bot.color}
          shapeSeed={bot.shapeSeed}
          size={BOT_SIZE}
          isWorking={false}
          drive={drive}
        />
      </View>
      {showLoader ? (
        <View
          style={[
            styles.barTrack,
            { backgroundColor: withAlpha(tokens.foreground, trackAlpha), bottom: BAR_BOTTOM },
          ]}
        >
          <Animated.View
            style={[
              styles.barIndicator,
              { backgroundColor: bot.color },
              reducedMotion ? null : barIndicatorStyle,
            ]}
          />
        </View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
  },
  halo: {
    position: "absolute",
    width: HALO_SIZE,
    height: HALO_SIZE,
    borderRadius: HALO_SIZE / 2,
  },
  haloStatic: {
    opacity: 0.5,
  },
  barTrack: {
    position: "absolute",
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    overflow: "hidden",
  },
  barIndicator: {
    position: "absolute",
    width: BAR_INDICATOR_WIDTH,
    height: "100%",
    borderRadius: BAR_HEIGHT / 2,
  },
});
