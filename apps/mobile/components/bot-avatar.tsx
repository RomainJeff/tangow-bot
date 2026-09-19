import type { AvatarStyle } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  avatarIdentitySeed,
  avatarShapeEyeOffset,
  organicAvatarPath,
} from "@rakazo/core";
import { memo, useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { G, Path, Rect } from "react-native-svg";
import { workingAvatarDuration, workingAvatarFrame } from "../lib/avatar-motion";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useAvatarStyle } from "./avatar-style";
import { NativeSymbol } from "./native-symbol";

const AnimatedRect = Animated.createAnimatedComponent(Rect);

export const BotAvatar = memo(function BotAvatar({
  color,
  size = 54,
  status,
  identity,
  shapeSeed,
  variant,
  muted = false,
}: {
  color: string;
  size?: number;
  status?: string;
  identity?: string;
  /** Picked organic shape; falls back to a shape derived from `identity`. */
  shapeSeed?: number | null;
  variant?: AvatarStyle;
  muted?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const isWorking = ACTIVE_RUN_STATUSES.some((activeStatus) => activeStatus === status);
  const { avatarStyle } = useAvatarStyle();
  const visorW = Math.round(size * 0.68);
  const visorH = Math.round(size * 0.44);
  const eyeW = Math.max(3, Math.round(size * 0.11));
  const eyeH = Math.max(4, Math.round(size * 0.17));
  const gap = Math.max(3, Math.round(size * 0.11));
  return (
    <View style={{ width: size, height: size }}>
      {(variant ?? avatarStyle) === "organic" ? (
        <OrganicAvatar
          color={color}
          identity={identity}
          shapeSeed={shapeSeed}
          size={size}
          isWorking={isWorking}
        />
      ) : (
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: color,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <View
            style={{
              width: visorW,
              height: visorH,
              borderRadius: Math.round(visorH * 0.52),
              backgroundColor: "#0C0C0E",
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap,
            }}
          >
            {[0, 1].map((eye) => (
              <View
                key={eye}
                style={{
                  width: eyeW,
                  height: eyeH,
                  borderRadius: Math.max(2, Math.round(eyeW * 0.6)),
                  backgroundColor: "#fff",
                }}
              />
            ))}
          </View>
        </View>
      )}
      {isWorking ? (
        <View
          accessibilityLabel={t("Working")}
          style={{
            position: "absolute",
            right: muted ? undefined : 0,
            left: muted ? 0 : undefined,
            bottom: 0,
            width: Math.max(6, Math.round(size * 0.18)),
            height: Math.max(6, Math.round(size * 0.18)),
            borderRadius: size,
            backgroundColor: "#F5A03C",
          }}
        />
      ) : null}
      {muted ? (
        <View
          accessible
          accessibilityLabel={t("Notifications silenced")}
          style={{
            position: "absolute",
            right: -2,
            bottom: -2,
            width: Math.max(14, Math.round(size * 0.34)),
            height: Math.max(14, Math.round(size * 0.34)),
            borderRadius: size,
            borderWidth: 2,
            borderColor: "#000",
            backgroundColor: "#242428",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <NativeSymbol
            ios="bell.slash.fill"
            android="notifications-off"
            size={Math.max(8, Math.round(size * 0.17))}
            color={tokens.foreground}
          />
        </View>
      ) : null}
    </View>
  );
});

function OrganicAvatar({
  color,
  identity,
  shapeSeed,
  size,
  isWorking,
}: {
  color: string;
  identity?: string;
  shapeSeed?: number | null;
  size: number;
  isWorking: boolean;
}) {
  const seed = shapeSeed ?? avatarIdentitySeed(identity || color || "#8B5CF6");
  const progress = useSharedValue(0);
  const reducedMotion = useReducedMotion();

  // Same eye grammar as web: fixed 7×21 bars, 16u apart, colour and optional
  // ink outline driven by the body luminance; no per-bot tilt.
  const luminance = relativeLuminance(color);
  const eyeFill = luminance < 0.4 ? "#FFFFFF" : "#101014";
  const needsInk = luminance > 0.78;
  const eyeBaseY = -10.5 + avatarShapeEyeOffset(seed);

  useEffect(() => {
    cancelAnimation(progress);
    progress.value = 0;
    if (isWorking && !reducedMotion) {
      progress.value = withRepeat(
        withTiming(1, {
          duration: workingAvatarDuration(seed),
          easing: Easing.linear,
        }),
        -1,
      );
    }
    return () => cancelAnimation(progress);
  }, [isWorking, progress, reducedMotion, seed]);

  const bodyStyle = useAnimatedStyle(() => {
    const frame = workingAvatarFrame(seed, progress.value);
    return {
      transform: [
        { translateX: (frame.translationX * size) / 120 },
        { translateY: (frame.translationY * size) / 120 },
        { rotate: `${frame.rotation}deg` },
        { scaleX: frame.scaleX },
        { scaleY: frame.scaleY },
      ],
    };
  });
  const leftEyeProps = useAnimatedProps(() => {
    const frame = workingAvatarFrame(seed, progress.value);
    return { x: -15 + frame.eyeOffsetX, y: eyeBaseY + frame.eyeOffsetY };
  });
  const rightEyeProps = useAnimatedProps(() => {
    const frame = workingAvatarFrame(seed, progress.value);
    return { x: 8 + frame.eyeOffsetX, y: eyeBaseY + frame.eyeOffsetY };
  });

  return (
    <View style={{ width: size, height: size }}>
      <Animated.View style={[{ width: size, height: size }, bodyStyle]}>
        <Svg width={size} height={size} viewBox="-60 -60 120 120">
          <Path
            d={organicAvatarPath(seed)}
            fill={color}
            stroke={needsInk ? "#17181A" : undefined}
            strokeWidth={needsInk ? 3.5 : undefined}
          />
          <G>
            <AnimatedRect
              animatedProps={leftEyeProps}
              width={7}
              height={21}
              rx={3.5}
              fill={eyeFill}
            />
            <AnimatedRect
              animatedProps={rightEyeProps}
              width={7}
              height={21}
              rx={3.5}
              fill={eyeFill}
            />
          </G>
        </Svg>
      </Animated.View>
    </View>
  );
}

/** WCAG relative luminance (0..1) of a hex colour. */
function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const expanded =
    clean.length === 3
      ? clean
          .split("")
          .map((c) => c + c)
          .join("")
      : clean;
  const r = parseInt(expanded.slice(0, 2), 16);
  const g = parseInt(expanded.slice(2, 4), 16);
  const b = parseInt(expanded.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 0.5;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
